import { Container } from "@cloudflare/containers";

import type { Bindings } from "@/types/app";

export class oem_imgTrans extends Container<Bindings> {
  defaultPort = 8080;
  sleepAfter = "5s";

  override async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request);
  }
}
