/* global WebSocketPair */
let mode = "position";
let initialFailureSent = false;
let initialRefreshRejected = false;
let credentialsRefreshed = false;
export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/test/mode") {
      mode = await request.text();
      initialFailureSent = false;
      initialRefreshRejected = false;
      credentialsRefreshed = false;
      return new Response("ok");
    }
    if (path === "/web/v1/auth/refresh") {
      if (mode === "upgrade-rejected" && !initialRefreshRejected) {
        initialRefreshRejected = true;
        return Response.json({ code: 1 }, { status: 503 });
      }
      credentialsRefreshed = true;
      return Response.json({ code: 0, data: { token: "renewed-token" } });
    }
    if (path === "/api/v1/websocket/token") {
      if (mode === "transport-error" && !initialFailureSent) {
        initialFailureSent = true;
        throw new Error("Game peer connection lost");
      }
      if (mode === "token-down" && !initialFailureSent) {
        initialFailureSent = true;
        return Response.json({ code: 1 }, { status: 503 });
      }
      return Response.json({ code: 0, data: { token: "local-token" } });
    }
    if (path === "/web/v1/game/endfield/map/me/position") {
      if (mode === "http-down" || mode === "fallback-expired") {
        return Response.json({ code: 1 }, { status: 503 });
      }
      return Response.json({
        code: 0,
        data: { pos: { x: 9, y: 0, z: 8 }, levelId: "http-level", isOnline: true, mapId: "map" },
      });
    }
    if (path !== "/ws/v1/game/endfield/map") {
      return new Response("Unknown fixture route", { status: 404 });
    }
    if (mode === "upgrade-rejected" && !credentialsRefreshed) {
      return new Response("Credential rejected", { status: 401 });
    }
    const query = new URL(request.url).searchParams;
    if (query.get("roleId") !== "role" || query.get("serverId") !== "1") {
      return new Response("Wrong game role", { status: 422 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener("message", (event) => {
      const { type, data } = JSON.parse(event.data);
      if (type === 1) {
        if (data.token !== "local-token") {
          server.close(1008, "Wrong socket token");
          return;
        }
        server.send(JSON.stringify({ type: 2 }));
      }
      if (type === 1011) {
        if (mode === "silent") {
          return;
        }
        if (mode === "device-rejected") {
          server.send(
            JSON.stringify({ type: 1012, data: { code: 10001, message: "Device rejected" } }),
          );
          return;
        }
        if (mode === "expired" || mode === "fallback-expired") {
          server.send(
            JSON.stringify({ type: 1012, data: { code: "10002", message: "Game login expired" } }),
          );
          return;
        }
        if (mode === "refresh" && !initialFailureSent) {
          initialFailureSent = true;
          server.send(JSON.stringify({ type: 1012, data: { code: 10000 } }));
        } else {
          // Ignore malformed peer frames and keep waiting for a usable position.
          server.send("not JSON");
          server.send(
            JSON.stringify({
              type: 1012,
              data: {
                pos: { x: "not-a-coordinate", z: 3 },
                levelId: "level",
                isOnline: true,
                mapId: "map",
              },
            }),
          );
          server.send(
            JSON.stringify({
              type: 1012,
              data: { pos: { x: 1, y: 2, z: 3 }, levelId: "level", isOnline: true, mapId: "map" },
            }),
          );
        }
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
