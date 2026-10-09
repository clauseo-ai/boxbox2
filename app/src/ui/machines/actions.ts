/* what the machines screen asks the server to do. each call is one verb
   row, and each answers an outcome in the interface's voice; the hosts are
   reread after anything that changes them, so the list is the server's. */

import { api } from "../../api/client";
import type { components } from "../../api/boxbox";
import { refreshHosts } from "../../store";
import { type Outcome, said, UNREACHABLE, verb } from "./verb";

export type Reloaded = components["schemas"]["Reloaded"];
export type PairedHost = components["schemas"]["PairedHost"];

export function reloadMachine(host: string): Promise<Outcome<Reloaded>> {
  return verb("reloadMachine", { surface: "machines", host, arg: host }, async () => {
    try {
      const { data, error, response } = await api.POST("/api/hosts/{host}/reload", { params: { path: { host } } });
      return data ? { ok: true, value: data } : { ok: false, error: said(error, response.status) };
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  });
}

export function restartMachine(host: string): Promise<Outcome<null>> {
  return verb("restartMachine", { surface: "machines", host, arg: host }, async () => {
    try {
      const { data, error, response } = await api.POST("/api/hosts/{host}/restart", { params: { path: { host } } });
      void refreshHosts();
      return data ? { ok: true, value: null } : { ok: false, error: said(error, response.status) };
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  });
}

export function forgetMachine(host: string): Promise<Outcome<null>> {
  return verb("forgetMachine", { surface: "machines", host, arg: host }, async () => {
    try {
      const { error, response } = await api.DELETE("/api/hosts/{host}", { params: { path: { host } } });
      await refreshHosts();
      return response.ok ? { ok: true, value: null } : { ok: false, error: said(error, response.status) };
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  });
}

export function pairMachine(url: string, token: string, name: string): Promise<Outcome<PairedHost>> {
  // the name is a host name, never free text; the address and token never leave for telemetry
  return verb("pairMachine", { surface: "machines", ...(name ? { host: name, arg: name } : {}) }, async () => {
    try {
      const body = { url, token, ...(name ? { name } : {}) };
      const { data, error, response } = await api.POST("/api/hosts/pair", { body });
      await refreshHosts();
      return data ? { ok: true, value: data } : { ok: false, error: said(error, response.status) };
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  });
}

/** what `cmx2 pair` prints: a `url` line and a `token` line. a paste of the
    whole output (or of both lines) fills both fields at once. */
export function readPairOutput(text: string): { url: string; token: string } | null {
  const url = /^\s*url\s+(\S+)/m.exec(text)?.[1];
  const token = /^\s*token\s+(\S+)/m.exec(text)?.[1];
  return url && token ? { url, token } : null;
}
