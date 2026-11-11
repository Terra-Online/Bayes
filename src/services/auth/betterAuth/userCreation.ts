import type { BetterAuthOptions, DBAdapter } from "better-auth";

import { createUser } from "@/repositories/users";

/** Keep the request's native adapter and schema checks; specialize only user creation. */
export function installUserCreation<Options extends BetterAuthOptions>(
  adapter: DBAdapter<Options>,
  db: D1Database,
): void {
  const defaultCreate = adapter.create.bind(adapter);
  adapter.create = async <T extends Record<string, unknown>, R = T>(input: {
    model: string;
    data: Omit<T, "id">;
    select?: string[];
    forceAllowId?: boolean;
  }): Promise<R> => {
    if (input.model !== "user") {
      return defaultCreate<T, R>(input);
    }
    const data = input.data;
    const id = input.forceAllowId && typeof data.id === "string" ? data.id : crypto.randomUUID();
    await createUser(db, {
      id,
      email: String(data.email),
      name: String(data.name ?? ""),
      emailVerified: data.emailVerified === true,
      image: typeof data.image === "string" ? data.image : null,
      createdAt: data.createdAt instanceof Date ? data.createdAt : new Date(),
      updatedAt: data.updatedAt instanceof Date ? data.updatedAt : new Date(),
    });
    // Let the native adapter apply the configured field/date/boolean output mapping.
    const user = await adapter.findOne<R>({
      model: "user",
      where: [{ field: "id", value: id }],
      select: input.select,
    });
    if (!user) {
      throw new Error("Created user could not be read.");
    }
    return user;
  };
}
