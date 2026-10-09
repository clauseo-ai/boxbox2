/* the tcc wrapper: launchd job root for the board daemon.
 *
 * tccd resolves microphone access against the JOB ROOT of a launchd
 * agent, and refuses to even prompt when that binary carries no
 * NSMicrophoneUsageDescription ("Policy disallows prompt", 2026-07-27 —
 * bare bun as job root meant silent denial and a sox stream of zeros).
 * this wrapper IS the job root: it embeds the usage description via
 * __TEXT,__info_plist (see install.sh), spawns bun as a child — spawn,
 * NOT exec: exec would swap the image back to bun and lose the plist —
 * and forwards the signals launchd uses for teardown.
 *
 * REBUILDS CHANGE THE CDHASH AND VOID THE TCC GRANT (re-prompt).
 * install.sh only compiles when the binary is missing or older than
 * this source. do not touch this file for fun.
 */

#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static pid_t child = -1;

static void forward(int sig) {
  if (child > 0) kill(child, sig);
}

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <program> [args...]\n", argv[0]);
    return 64;
  }

  signal(SIGTERM, forward);
  signal(SIGINT, forward);
  signal(SIGHUP, forward);

  int rc = posix_spawn(&child, argv[1], NULL, NULL, &argv[1], environ);
  if (rc != 0) {
    fprintf(stderr, "boxbox-board wrapper: spawn failed (%d)\n", rc);
    return 71;
  }

  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    /* EINTR from a forwarded signal: keep waiting for the child */
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 0;
}
