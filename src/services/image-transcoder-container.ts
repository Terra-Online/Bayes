import { Container } from "@cloudflare/containers";
import type { Bindings } from "../types/app";

export class oem_imgTrans extends Container<Bindings> {
  defaultPort = 8080;
  sleepAfter = "5s";

  override async fetch(request: Request): Promise<Response> {
    const response = await this.containerFetch(request);
    if (new URL(request.url).pathname !== "/prepare") {
      return response;
    }

    const body = await response.arrayBuffer();
    await this.destroy().catch(() => undefined);
    return new Response(body, {
      status: response.status,
      headers: response.headers
    });
  }
}
