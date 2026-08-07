declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../index");
    durableNamespaces: "OEMStatsDO" | "OEMUserDO" | "OEMNotificationDO" | "oem_imgTrans";
  }
}
