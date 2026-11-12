import { createUser as insertUser, type CreateUserInput } from "@/repositories/users";
import { buildUidSuffixFromNickname } from "@/services/profile/contract/publicUid";

function normalizeNickname(raw: string | undefined, uid: string, email?: string): string[] {
  const source = (raw ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 26);
  const emailLocalPart = (email?.split("@")[0] ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 26);
  const compactUid = uid.replace(/[^A-Za-z0-9]/g, "");
  const fallback = `U${compactUid.slice(0, 7)}`;

  const candidates = [
    source,
    source ? `${source.slice(0, 20)}${compactUid.slice(0, 6)}` : "",
    emailLocalPart,
    emailLocalPart ? `${emailLocalPart.slice(0, 20)}${compactUid.slice(0, 6)}` : "",
    fallback,
    `U${compactUid.slice(-7)}`,
  ].filter((item) => item.length > 0 && item.length <= 26);

  return Array.from(new Set(candidates));
}

/** Allocate the public number atomically; its provisional suffix is finalized at nickname confirmation. */
export async function createUser(
  db: D1Database,
  identity: Omit<CreateUserInput, "profileCandidates">,
): Promise<void> {
  const email = identity.email.toLowerCase();
  const profileCandidates = normalizeNickname(identity.name, identity.id, email).map(
    (nickname) => ({
      nickname,
      uidSuffix: buildUidSuffixFromNickname(nickname),
    }),
  );
  await insertUser(db, { ...identity, email, profileCandidates });
}
