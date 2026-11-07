(() => {
  'use strict';
  const t = window.stm32I18n.t;
  const api = acquireVsCodeApi();
  const el = id => document.getElementById(id);
  let state;
  let pending = false;
  const actions = ['build', 'flash', 'debug'];
  const probeOptions = [['cmsis-dap', 'DAPLink / CMSIS-DAP'], ['st-link', 'ST-Link'], ['jlink', 'J-Link']];
  const probeName = value => probeOptions.find(([probe]) => probe === value)?.[1] ?? probeOptions[0][1];
  function post(action, extra = {}) {
    if (pending && action !== 'stop') return;
    el('error').hidden = true;
    if (action !== 'stop') pending = true;
    api.postMessage({ type: 'action', action, projectUri: state?.project?.settings.projectUri ?? '',
      revision: state?.project?.revision ?? 0, snapshotRevision: state?.snapshot.revision ?? 0, ...extra });
    enabled();
  }
  function enabled() {
    if (!state) return;
    for (const id of ['project', 'preset', 'target', 'probe', 'optimization']) el(id).disabled = pending || state.busy;
    el('preset').disabled ||= !state.project || !state.configurations.length;
    el('target').disabled ||= !state.project || !state.targets.length;
    el('probe').disabled ||= !state.project;
    el('optimization').disabled ||= !state.project;
    for (const action of actions) {
      el(action).disabled = pending || !state.capabilities[action].enabled;
      el(action).title = state.capabilities[action].reason;
    }
    document.querySelectorAll('[data-action]').forEach(button => {
      if (!actions.includes(button.dataset.action) && button.dataset.action !== 'stop') button.disabled = pending;
    });
    el('stop').hidden = !state.workflowBusy;
    el('stop').disabled = !state.workflowBusy;
  }
  function options(id, entries, selected, placeholder) {
    const select = el(id);
    select.replaceChildren();
    for (const item of [{ value: '', label: placeholder }, ...entries]) {
      const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; select.append(option);
    }
    if (selected && !entries.some(item => item.value === selected)) {
      const option = document.createElement('option'); option.value = selected; option.textContent = t("{0} · 待刷新", selected); select.append(option);
    }
    select.value = selected ?? '';
  }
  function render(message) {
    state = message;
    const settings = message.project?.settings;
    const currentProject = message.projects.find(item => item.uri === settings?.projectUri);
    el('title').textContent = currentProject?.label || 'STM32 Easy Tool Kit';
    el('empty').hidden = message.projects.length > 0;
    el('selection').hidden = !message.projects.length;
    options('project', message.projects.map(item => ({ value: item.uri, label: item.label })), settings?.projectUri, t("选择工程"));
    const presetDefault = settings?.configurePreset
      ?? (message.configurations.find(item => item.name === 'Debug') ?? message.configurations[0])?.name;
    options('preset', message.configurations.map(item => ({ value: item.name, label: item.label })), presetDefault, t("读取并选择构建方案"));
    el('optimization').value = message.optimization?.level ?? 'default';
    el('optimizationHint').hidden = el('optimization').value === 'default';
    el('optimizationHint').textContent = t('覆盖为 -{0} · 下次编译生效', el('optimization').value);
    options('target', message.targets.map((item, index) => ({ value: String(index), label: item.name + (item.configuration ? ` · ${item.configuration}` : '') })),
      settings?.targetId ? String(message.targets.findIndex(item => item.id === settings.targetId && item.configuration === settings.configuration)) : '', t("配置后识别；编译时可选择"));
    el('source').textContent = settings?.sourceDirectory ?? '';
    el('buildPreset').textContent = t("构建预设：{0}", settings?.buildPreset ?? t("不使用 Build Preset"));
    const probe = el('probe');
    probe.replaceChildren();
    for (const [value, label] of probeOptions) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; probe.append(option);
    }
    probe.value = settings?.probe ?? 'cmsis-dap';
    el('probeDetail').textContent = `${probeName(probe.value)} / SWD · ${settings?.speedKHz ?? 1000} kHz · ${settings?.chipLabel ?? t("未设置芯片")}`;
    const needsSetup = settings && (!message.cmakeProject || !message.readiness.build.enabled || !settings.configurePreset);
    el('onboarding').hidden = !needsSetup;
    el('nextTitle').textContent = t("下一步");
    el('nextHint').textContent = !message.readiness.build.enabled ? message.readiness.build.reason : t("选择构建方案，配置后即可编译。");
    const current = message.snapshot.projectUri === settings?.projectUri;
    el('status').textContent = message.toolBusy ? t("正在处理工具，请稍候…") : current ? message.snapshot.message : t("尚未执行操作");
    el('status').className = current && ['failed', 'uncertain'].includes(message.snapshot.phase) ? 'failure' : '';
    el('artifact').textContent = message.artifact ? t("固件：{0}", message.artifact) : '';
    const flash = message.snapshot.lastFlash;
    const metrics = message.enhancement;
    const summary = el('result-summary'); summary.replaceChildren();
    if (metrics && metrics.elapsedMs !== undefined) for (const [label,value] of [[summary.dataset.duration,(metrics.elapsedMs/1000).toFixed(1)],[summary.dataset.errors,metrics.errors??0],[summary.dataset.warnings,metrics.warnings??0]]) { const item=document.createElement('div'),number=document.createElement('strong'); item.textContent=label;number.textContent=String(value);item.append(number);summary.append(item); }
    el('memory-mini').textContent=(metrics?.memory??[]).map(r=>r.name+': '+(r.used/1024).toFixed(1)+' KiB'+(r.capacity?' / '+(r.capacity/1024).toFixed(0)+' KiB':'')).join(' · ');
    el('history').textContent = flash && settings && flash.projectUri === settings.projectUri ? t("上次烧录成功：{0}", new Date(flash.at).toLocaleString(window.stm32I18n.language)) : '';
    el('repair').hidden = !current || !['failed', 'uncertain'].includes(message.snapshot.phase);
    el('repair').textContent = message.repair.label;
    el('repair').onclick = () => post(message.repair.action);
    const list = el('capabilities'); list.replaceChildren();
    for (const [action, label] of [['build', t("编译环境")], ['flash', t("烧录配置")], ['debug', t("调试依赖")]]) {
      const cap = message.readiness[action];
      const row = document.createElement('div'); row.className = 'readiness';
      const heading = document.createElement('strong'); heading.textContent = label;
      const status = document.createElement('span'); status.className = cap.enabled ? 'badge' : 'hint'; status.textContent = cap.enabled ? t("已配置") : t("待处理");
      const reason = document.createElement('p'); reason.className = 'hint'; reason.textContent = cap.enabled ? (action === 'build' ? 'Arm GNU · CMake · Ninja' : action === 'flash' ? `${probeName(settings?.probe)} / SWD` : 'Cortex-Debug') : cap.reason;
      row.append(heading, status, reason);
      if (!cap.enabled && cap.repair) {
        const button = document.createElement('button'); button.className = 'link'; button.textContent = ({ tools: t("管理工具"), setup: t("配置工程"), dap: t("设置芯片"), cortex: t("安装 / 更新扩展"), log: t("查看说明") })[cap.repair] ?? t("查看设置");
        button.onclick = () => cap.repair === 'log' ? post('dap') : post(cap.repair); row.append(button);
      }
      list.append(row);
    }
    enabled();
  }
  document.querySelectorAll('[data-action]').forEach(button => button.onclick = () => post(button.dataset.action));
  el('project').onchange = () => { if (el('project').value) post('project', { value: el('project').value }); };
  el('preset').onchange = () => { if (el('preset').value) post('preset', { value: el('preset').value }); };
  el('optimization').onchange = () => post('optimization', { value: el('optimization').value, featureRevision: state?.optimization?.revision });
  el('target').onchange = () => {
    const target = state?.targets[Number(el('target').value)];
    if (el('target').value !== '' && target) post('target', { value: target.id, configuration: target.configuration });
  };
  el('probe').onchange = () => post('probe', { value: el('probe').value });
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') render(data);
    else if (data.type === 'complete') { pending = false; enabled(); }
    else if (data.type === 'error') { pending = false; el('error').textContent = data.message; el('error').hidden = false; el('error').focus(); enabled(); }
  });
  api.postMessage({ type: 'ready' });
})();
