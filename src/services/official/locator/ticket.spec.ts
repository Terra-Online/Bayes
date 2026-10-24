import { expect, it } from "vitest";

import type { Bindings } from "@/types/app";

import { issueLocatorSocketTicket, verifyLocatorSocketTicket } from "./ticket";

it("binds locator tickets to the configured service secret across rotation", async () => {
  const bindings = {
    SERVICE_ID_HMAC_SECRET: "first-locator-service-secret-at-least-32-characters",
  } as Bindings;
  const ticket = await issueLocatorSocketTicket(bindings, "owner");
  await expect(verifyLocatorSocketTicket(bindings, ticket)).resolves.toBe("owner");
  bindings.SERVICE_ID_HMAC_SECRET = "replacement-locator-service-secret-at-least-32-characters";
  await expect(verifyLocatorSocketTicket(bindings, ticket)).resolves.toBeNull();
  delete bindings.SERVICE_ID_HMAC_SECRET;
  await expect(verifyLocatorSocketTicket(bindings, ticket)).resolves.toBeNull();
});
