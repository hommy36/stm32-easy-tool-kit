import { t } from '../i18n';
export function redact(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, t("$1[凭据已隐藏]@"))
    .replace(/([?&](?:token|sig|signature|password|key)=)[^&\s]+/gi, t("$1[已隐藏]"));
}

export function diagnose(text: string): string {
  if (/SHA-256|大小不匹配|size mismatch/i.test(text)) return t("工具包与固定清单不一致：重新下载所选版本，或导入匹配的离线 ZIP。");
  if (/CERT|certificate|TLS|证书/i.test(text)) return t("TLS/证书校验失败：检查系统时间、企业代理证书或使用已验证离线包，不要关闭证书验证。");
  if (/ENOTFOUND|ECONN|ETIMEDOUT|HTTP |代理|超时|proxy|timed out/i.test(text)) return t("网络或代理可能不可用：核对 VS Code http.proxy、网络连通性，或导入离线包。");
  if (/ENOENT|DLL|0xc000|322122/i.test(text)) return t("可能缺少文件或运行依赖：请选择完整发行目录，或重新安装推荐工具。");
  if (/unable to find|no.*cmsis.dap|not found.*cmsis/i.test(text)) return t("未发现可用 CMSIS-DAP 接口：检查探针 USB 模式及 HID/WinUSB 驱动；盘符和串口不能证明调试接口可用。");
  if (/LIBUSB_ERROR_BUSY|device.*busy/i.test(text)) return t("探针可能被其他程序占用：先关闭其他调试会话，不要强行终止无关进程。");
  if (/LIBUSB_ERROR_ACCESS|permission denied/i.test(text)) return t("可能是权限或接口驱动问题：核对目标调试接口，不要替换整个复合设备驱动。");
  return t("原因未确定，请保留原始日志，核对工具路径、版本与工程中的显式覆盖。");
}
