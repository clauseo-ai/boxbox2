# a linux machine with systemd as pid 1 and one lingering user, `ops`, for
# ops/test/container.sh: the release is installed with install.sh, the unit
# is verified with systemd-analyze and run by the user's manager, as on a
# real vm. nothing here is published; it exists only for the test.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session libpam-systemd \
      ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/*
# the machine's own services (journald, logind) run under seccomp
# filters that an emulated x86_64 process trips (under rosetta they die
# with sigtrap), and without logind no user manager starts. the filters are
# lifted for system services only; the unit under test is a user unit and
# runs exactly as shipped.
RUN mkdir -p /etc/systemd/system/service.d \
 && printf '[Service]\nSystemCallArchitectures=\nSystemCallFilter=\nMemoryDenyWriteExecute=no\n' \
      >/etc/systemd/system/service.d/10-emulation.conf
# a persistent journal splits out each user's journal, so `journalctl
# --user` reads the unit's log as it would on a vm
RUN mkdir -p /var/log/journal
# linger starts the user's manager at boot, as `loginctl enable-linger`
RUN useradd --create-home --uid 1000 --shell /bin/bash ops \
 && mkdir -p /var/lib/systemd/linger \
 && touch /var/lib/systemd/linger/ops
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
