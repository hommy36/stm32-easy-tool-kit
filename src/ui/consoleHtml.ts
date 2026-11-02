import { t, escapeHtml } from '../i18n';
export function consoleBody(): string {
  return `
<main class="console">
<header class="console-heading"><strong id="title">STM32 Easy Tool Kit</strong><button class="quiet" data-action="refresh" aria-label="${escapeHtml(t("刷新工作台"))}">${escapeHtml(t("刷新"))}</button></header>
<p id="error" class="error" role="alert" tabindex="-1" hidden></p>
<section aria-labelledby="projectHeading"><h2 id="projectHeading">${escapeHtml(t("当前工程"))}</h2>
<div id="empty" hidden><p>${escapeHtml(t("打开已有 STM32 CMake 工程，开始编译、烧录和调试。"))}</p><button data-action="openFolder">${escapeHtml(t("打开工程文件夹"))}</button></div>
<div id="selection"><label for="project">${escapeHtml(t("工程"))}</label><select id="project"></select>
<label for="preset">${escapeHtml(t("构建方案"))}</label><select id="preset"></select><button id="load" class="link" data-action="loadChoices">${escapeHtml(t("读取构建方案"))}</button>
<label for="target">${escapeHtml(t("固件目标"))}</label><select id="target"></select>
<details><summary>${escapeHtml(t("路径与配置详情"))}</summary><p id="source" class="path"></p><p id="buildPreset" class="hint"></p><p id="probe" class="hint"></p></details></div>
<div id="onboarding" class="callout" hidden><strong id="nextTitle"></strong><p id="nextHint"></p><button data-action="setup">${escapeHtml(t("配置工程"))}</button></div></section>
<section aria-label="${escapeHtml(t("常用操作"))}"><div class="primary-actions"><button id="build" data-action="build">${escapeHtml(t("编译"))}</button><button id="flash" data-action="flash">${escapeHtml(t("烧录"))}</button><button id="debug" data-action="debug">${escapeHtml(t("调试"))}</button></div><p class="hint compact">${escapeHtml(t("烧录和调试前会先编译当前工程"))}</p><button id="stop" class="secondary full" data-action="stop" hidden>${escapeHtml(t("停止当前操作"))}</button></section>
<section aria-labelledby="resultHeading"><h2 id="resultHeading">${escapeHtml(t("操作结果"))}</h2><p id="status" role="status" aria-live="polite">${escapeHtml(t("正在读取工程…"))}</p><p id="artifact" class="path"></p><p id="history" class="hint"></p><div class="actions"><button class="link" id="repair" hidden></button><button class="link" data-action="log">${escapeHtml(t("查看日志"))}</button></div></section>
<section aria-labelledby="environmentHeading"><h2 id="environmentHeading">${escapeHtml(t("环境与配置"))}</h2><div id="capabilities"></div><p class="hint compact">${escapeHtml(t("环境检查不连接探针；烧录记录仅表示历史结果。"))}</p></section>
<section aria-label="${escapeHtml(t("辅助工具"))}"><div class="actions"><button class="secondary" data-action="settings">${escapeHtml(t("工程设置"))}</button><button class="secondary" data-action="tools">${escapeHtml(t("工具管理"))}</button><button class="secondary" data-action="cubeMx">STM32CubeMX</button></div><details><summary>${escapeHtml(t("更多"))}</summary><div class="actions"><button class="link" data-action="configure">${escapeHtml(t("重新配置 CMake"))}</button><button class="link" data-action="clion">${escapeHtml(t("沿用 CLion 配置…"))}</button><button class="link" data-action="externals">${escapeHtml(t("外部依赖"))}</button><button class="link" data-action="terminal">${escapeHtml(t("工具终端"))}</button><button class="link" data-action="guide">${escapeHtml(t("接线与探针说明"))}</button></div></details></section>
</main>`;
}
