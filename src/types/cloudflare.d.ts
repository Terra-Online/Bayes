declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../index");
    durableNamespaces: "OEMStatsDO" | "OEMUserDO" | "oem_imgTrans";
  }
}

