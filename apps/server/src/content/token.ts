import { signPayload, verifyPayload } from "../auth/signed.ts";
import type { Env } from "../env.ts";

const INFO = "content";

/** The payload in 04. */
export type ContentPayload = {
  a: string;
  v: number;
  c: { kind: "person" | "guest"; id: string; name: string; canComment: boolean; isPublisher: boolean };
  exp: number;
};

export const signContentToken = (env: Env, payload: ContentPayload) =>
  signPayload(payload, env.sessionSecret, INFO);

export const verifyContentToken = (env: Env, token: string) =>
  verifyPayload<ContentPayload>(token, env.sessionSecret, INFO);
