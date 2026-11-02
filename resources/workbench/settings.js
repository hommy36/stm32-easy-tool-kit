(() => {
  'use strict';
  const t = window.stm32I18n.t;
  const api = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const cached = api.getState();
  const steps = ['project', 'tools', 'build', 'finish'];
  let state, base, draft;
  let dirty = false, pending = false, busy = false, conflict = false, initialized = false;
  let page = cached?.page ?? 'build';
  let options = {};
  let snapshotRevision = 0;
  let afterSavePage;
  const error = message => { byId('error').textContent = message; byId('error').hidden = false; byId('error').focus(); };
  const persist = () => api.setState({ page, draft: dirty ? draft : undefined, base: dirty ? base : undefined });
  const identity = () => ({ projectUri: base?.settings.projectUri ?? '', revision: base?.revision ?? 0, snapshotRevision });
  function enabled() {
    byId('fields').disabled = busy || pending;
    byId('fields').querySelectorAll('input, select, button').forEach(field => {
      field.disabled = !state?.project && !['projectChoice', 'openFolder'].includes(field.id);
    });
    // Project selection and opening a folder must also work with no selected project.
    if ((draft?.probe ?? 'cmsis-dap') !== 'cmsis-dap') byId('backend').disabled = true;
    byId('projectChoice').disabled = busy || pending || dirty;
    byId('save').disabled = busy || pending || conflict || !state?.project;
    byId('configure').disabled = busy || pending || conflict || !state?.readiness.build.enabled;
    byId('finishBuild').disabled = busy || pending || conflict || !state?.readiness.build.enabled;
    byId('cancel').disabled = pending;
    byId('next').disabled = busy || pending || conflict;
    byId('previous').disabled = pending;
    byId('stop').hidden = !state?.workflowBusy;
    byId('importClion').disabled = busy || pending || conflict || dirty || !state?.project;
    byId('deleteSettings').disabled = busy || pending || conflict || !state?.project;
    document.querySelectorAll('[data-tool]').forEach(button => { button.disabled = busy || pending || conflict; });
    byId('dirty').textContent = dirty ? t("有未保存修改") : draft?.shareInProject ? t('配置随工程保存：.vscode/stm32-easy.json') : t("设置保存在本机插件存储中");
    byId('conflict').hidden = !conflict;
  }
  function navigate(next) {
    page = next;
    const setup = options.setup && !options.tools;
    const toolsOnly = options.tools;
    for (const name of ['project', 'build', 'dap', 'advanced', 'tools', 'finish']) {
      byId(name).hidden = toolsOnly ? name !== 'tools' : name !== page && !(page === 'advanced' && name === 'project');
    }
    byId('deleteConfiguration').hidden = !!toolsOnly || page !== 'advanced';
    byId('navigation').hidden = !!setup || !!toolsOnly;
    byId('clionImport').hidden = !!toolsOnly;
    byId('stepper').hidden = !setup;
    byId('layout').classList.toggle('single', !!setup || !!toolsOnly);
    byId('title').textContent = toolsOnly ? t("工具管理") : setup ? t("配置工程") : t("工程设置");
    document.querySelectorAll('[data-page], [data-step]').forEach(button => {
      if ((button.dataset.page ?? button.dataset.step) === page) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    });
    byId('save').hidden = !!toolsOnly || ['tools', 'finish'].includes(page);
    byId('cancel').hidden = !!toolsOnly;
    byId('next').hidden = !setup || !steps.includes(page) || page === 'finish';
    byId('previous').hidden = !setup || steps.indexOf(page) <= 0;
    byId('next').textContent = page === 'build' ? t("完成构建设置") : t("下一步");
    persist(); enabled();
  }
  function selectOptions(id, entries, selected, placeholder) {
    const select = byId(id); select.replaceChildren();
    const add = (value, label) => { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); };
    add('', placeholder);
    for (const item of entries) add(item.value, item.label);
    if (selected && !entries.some(item => item.value === selected)) add(selected, t("{0}（待重新识别）", selected));
    select.value = selected ?? '';
  }
  const probeLabels = { 'cmsis-dap': 'DAPLink / CMSIS-DAP', 'st-link': 'ST-Link', jlink: 'J-Link' };
  function probeName(value) { return probeLabels[value] ?? probeLabels['cmsis-dap']; }
  function renderDraft() {
    if (!draft) return;
    for (const key of ['sourceDirectory', 'chipLabel', 'targetScript', 'backend', 'speedKHz', 'serial']) byId(key).value = draft[key] ?? '';
    for (const key of ['stopAtMain']) byId(key).checked = !!draft[key];
    byId('shareInProject').checked = draft?.shareInProject !== false;
    byId('probe').value = draft.probe ?? 'cmsis-dap';
    byId('backend').disabled = (draft.probe ?? 'cmsis-dap') !== 'cmsis-dap';
    byId('scriptKind').value = draft.scriptKind ?? 'target';
    byId('scriptLabel').textContent = draft.scriptKind === 'board' ? t('完整 OpenOCD 配置脚本（CLion board）') : t('芯片配置脚本（OpenOCD target）');
    if (!draft.configurePreset && state.configurations.length) {
      draft.configurePreset = (state.configurations.find(item => item.name === 'Debug') ?? state.configurations[0]).name;
    }
    selectOptions('configurePreset', state.configurations.map(item => ({ value: item.name, label: item.displayName || item.name })), draft.configurePreset, t("选择已有构建方案"));
    const configuration = state.configurations.find(item => item.name === draft.configurePreset);
    selectOptions('buildPreset', (configuration?.builds ?? []).map(item => ({ value: item.name, label: item.displayName || item.name })), draft.buildPreset, t("不使用 Build Preset"));
    const targets = draft.configurePreset === state.project?.settings.configurePreset && draft.buildPreset === state.project?.settings.buildPreset ? state.targets : [];
    selectOptions('targetId', targets.map(item => ({ value: JSON.stringify([item.id, item.configuration]), label: `${item.name}${item.configuration ? ` · ${item.configuration}` : ''}` })),
      draft.targetId ? JSON.stringify([draft.targetId, draft.configuration]) : '', t("配置后识别 / 选择固件目标"));
    byId('binaryDirectory').textContent = configuration?.binaryDirectory ?? t("读取方案后显示");
    byId('targetSummary').textContent = targets.length ? t("已识别 {0} 个可执行目标", targets.length) : t("保存并配置后显示固件目标");
    byId('dapSummary').textContent = `${probeName(draft.probe)} / SWD · ${byId('backend').disabled ? '' : `${draft.backend} · `}${draft.speedKHz} kHz${draft.serial ? ` · ${draft.serial}` : ''}`;
  }
  function renderTools() {
    const list = byId('toolList'); list.replaceChildren();
    const purposes = { armGnu: t("编译器、链接器与 GDB"), cmake: t("读取构建方案并生成构建规则"), ninja: t("执行增量编译"), openocd: t("连接探针、烧录与调试服务（可稍后配置）") };
    for (const tool of state.tools) {
      const row = document.createElement('article'); row.className = 'tool-row';
      const head = document.createElement('div'); head.className = 'tool-heading';
      const name = document.createElement('h3'); name.textContent = tool.name;
      const status = document.createElement('span'); status.className = 'badge'; status.textContent = tool.status; head.append(name, status);
      const purpose = document.createElement('p'); purpose.className = 'hint'; purpose.textContent = purposes[tool.id];
      const location = document.createElement('p'); location.className = 'path'; location.textContent = tool.root ?? t("尚未选择安装目录");
      const version = document.createElement('p'); version.className = 'hint'; version.textContent = tool.version ? `${tool.version} · ${tool.source === 'managed' ? t("插件安装") : t("已有安装")}` : '';
      const actions = document.createElement('div'); actions.className = 'actions';
      for (const [action, label] of [['select', t("选择已有")], ['install', t("安装…")], ['check', t("检查")], ['import', t("离线导入")], ['copy', t("复制路径")]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = action === 'copy' ? 'link' : 'secondary'; button.dataset.tool = tool.id; button.textContent = label;
        button.onclick = () => post('toolAction', { tool: tool.id, action }); actions.append(button);
      }
      row.append(head, purpose, version, location, actions);
      if (tool.checks.length) {
        const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = t("检查详情");
        const checks = document.createElement('ul'); checks.className = 'tool-checks';
        for (const check of tool.checks) { const li = document.createElement('li'); li.textContent = `${({ ok: t("通过"), warning: t("提醒"), error: t("失败"), unverified: t("未验证") })[check.status]}：${check.summary}`; checks.append(li); }
        details.append(summary, checks); row.append(details);
      }
      list.append(row);
    }
  }
  function render(message) {
    state = message; busy = message.busy; snapshotRevision = message.snapshotRevision;
    if (!initialized) {
      options = message.options;
      if (cached?.draft && cached.base) { draft = cached.draft; base = cached.base; dirty = true; }
      else { base = message.project; draft = base ? { ...base.settings } : undefined; }
      page = options.tools ? 'tools' : options.page ?? (options.setup ? (cached?.page && steps.includes(cached.page) ? cached.page : 'project') : 'build');
      initialized = true;
    }
    if (message.replaceDraft || !dirty) { base = message.project; draft = base ? { ...base.settings } : undefined; dirty = false; }
    conflict = dirty && (base?.settings.projectUri !== message.project?.settings.projectUri || base?.revision !== message.project?.revision);
    byId('projectPath').textContent = options.tools ? t("本机工具环境 · 所有工程共享") : base?.settings.sourceDirectory ?? t("尚未选择工程");
    byId('status').textContent = message.toolBusy ? t("正在处理工具…") : message.snapshot.projectUri === message.project?.settings.projectUri ? message.snapshot.message : '';
    selectOptions('projectChoice', message.projects.map(item => ({ value: item.uri, label: item.label })), base?.settings.projectUri, t("选择工作区工程"));
    byId('projectCheck').textContent = message.project ? message.cmakeProject ? t("已识别 CMake 工程") : t("当前目录没有 CMakeLists.txt，请修改源码目录或打开已有 CMake 工程。") : t("请先打开或选择工程。");
    byId('authorization').textContent = message.authorized ? t("已记住当前配置的硬件确认") : message.authorizationStored ? t("之前的确认已不匹配当前配置，下次操作需重新确认") : t("尚未记住硬件确认");
    byId('revokeAuthorization').hidden = !message.authorizationStored;
    byId('cortexState').textContent = message.cortex ? t("Cortex-Debug 已安装") : t("调试还需安装 Cortex-Debug 1.12.1 或兼容的 1.x");
    byId('finishSummary').textContent = message.readiness.build.enabled ? t("编译环境已配置 · {0}", draft?.configurePreset ?? t("尚未选择构建方案")) : message.readiness.build.reason;
    byId('artifact').textContent = message.artifact ?? '';
    renderDraft(); renderTools(); navigate(page); persist();
  }
  function post(type, extra = {}) {
    if (type === 'stop') { api.postMessage({ type }); return; }
    if (pending || (busy && type !== 'cancel')) return;
    if (conflict && type !== 'cancel') { error(t("当前草稿基于旧设置，请先放弃修改并重新加载。")); return; }
    if (type === 'loadChoices' && draft?.sourceDirectory !== base?.settings.sourceDirectory) { error(t("请先保存源码目录修改，再读取方案。")); return; }
    byId('error').hidden = true;
    pending = true; enabled();
    api.postMessage({ type, ...identity(), ...extra });
  }
  function changed() {
    if (!draft) return;
    dirty = true; byId('error').hidden = true; persist(); enabled();
  }
  function collect() {
    if (!draft) return;
    for (const key of ['sourceDirectory', 'chipLabel', 'targetScript', 'serial', 'configurePreset', 'buildPreset']) draft[key] = byId(key).value.trim() || undefined;
    draft.backend = byId('backend').value;
    draft.probe = byId('probe').value;
    draft.scriptKind = byId('scriptKind').value === 'board' ? 'board' : undefined;
    draft.speedKHz = Number(byId('speedKHz').value);
    draft.stopAtMain = byId('stopAtMain').checked;
    draft.shareInProject = byId('shareInProject').checked;
    const selection = byId('targetId').value ? JSON.parse(byId('targetId').value) : [];
    draft.targetId = selection[0]; draft.configuration = selection[1] ?? undefined;
    const target = state.targets.find(item => item.id === draft.targetId && item.configuration === draft.configuration);
    if (target) draft.preferredTarget = target.name;
  }
  function save(type = 'save') {
    collect();
    for (const id of ['sourceDirectory', 'speedKHz']) {
      const field = byId(id);
      if (!field.checkValidity()) { navigate(id === 'sourceDirectory' && options.setup ? 'project' : 'advanced'); field.focus(); field.reportValidity(); return; }
    }
    if (type !== 'save' && !draft?.configurePreset) { navigate('build'); error(t("请先读取并选择构建方案。")); return; }
    post(type, { settings: draft });
  }
  document.querySelectorAll('[data-page], [data-step]').forEach(button => button.onclick = () => navigate(button.dataset.page ?? button.dataset.step));
  byId('settings').addEventListener('input', event => {
    if (!event.target.closest('#fields') || event.target.id === 'projectChoice') return;
    if (['chipLabel', 'targetScript', 'scriptKind'].includes(event.target.id)) draft.chipConfirmed = false;
    collect(); changed();
  });
  byId('configurePreset').onchange = () => {
    if (!draft) return;
    draft.configurePreset = byId('configurePreset').value || undefined;
    draft.preferredTarget = undefined;
    const choices = state.configurations.find(item => item.name === draft.configurePreset)?.builds ?? [];
    draft.buildPreset = (choices.find(item => item.name === draft.configurePreset) ?? (choices.length === 1 ? choices[0] : undefined))?.name;
    draft.targetId = undefined; draft.configuration = undefined; renderDraft(); changed();
  };
  byId('buildPreset').onchange = () => { draft.buildPreset = byId('buildPreset').value || undefined; draft.targetId = undefined; draft.configuration = undefined; renderDraft(); changed(); };
  byId('projectChoice').onchange = () => { if (byId('projectChoice').value) post('selectProject', { value: byId('projectChoice').value }); };
  byId('settings').onsubmit = event => { event.preventDefault(); save(); };
  byId('configure').onclick = () => save('saveAndConfigure');
  byId('finishBuild').onclick = () => save('finishBuild');
  byId('importClion').onclick = () => { if (!dirty) post('importClion'); };
  byId('detectTargetScript').onclick = () => { collect(); post('detectTargetScript', { settings: draft }); };
  byId('scriptKind').onchange = () => { collect(); renderDraft(); changed(); };
  byId('probe').onchange = () => { collect(); renderDraft(); changed(); };
  for (const id of ['cancel', 'loadChoices', 'pickTargetScript', 'revokeAuthorization', 'deleteSettings']) byId(id).onclick = () => post(id);
  for (const id of ['openLog', 'openCortex', 'openFolder', 'stop']) byId(id).onclick = () => api.postMessage({ type: id });
  byId('continueDap').onclick = () => { options = { ...options, setup: false }; navigate('dap'); };
  byId('previous').onclick = () => navigate(steps[Math.max(0, steps.indexOf(page) - 1)]);
  byId('next').onclick = () => {
    if (page === 'project') {
      if (!state.project) { error(t("请先打开或选择工程。")); return; }
      if (dirty) { afterSavePage = 'tools'; save(); }
      else if (!state.cmakeProject) error(t("当前源码目录没有 CMakeLists.txt。"));
      else navigate('tools');
    } else if (page === 'tools') {
      if (!state.readiness.build.enabled) { error(state.readiness.build.reason); return; }
      navigate('build'); if (!state.configurations.length) post('loadChoices');
    } else if (page === 'build') {
      if (!draft?.targetId || !state.targets.length) { afterSavePage = 'finish'; save('saveAndConfigure'); }
      else { afterSavePage = 'finish'; save(); }
    }
  };
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') render(data);
    else if (data.type === 'status') { busy = data.busy; snapshotRevision = data.snapshotRevision; if (state) state.workflowBusy = data.workflowBusy; byId('status').textContent = data.message; enabled(); }
    else if (data.type === 'error') { pending = false; afterSavePage = undefined; enabled(); error(data.message); }
    else if (data.type === 'operationComplete') { pending = false; enabled(); }
    else if (data.type === 'saved') {
      byId('status').textContent = data.action === 'save' ? t("设置已保存") : data.action === 'finishBuild' ? t("编译完成，可以返回侧栏继续操作") : t("CMake 配置完成");
      if (afterSavePage) { const next = afterSavePage; afterSavePage = undefined; if (next === 'tools' && state.cmakeProject || next === 'finish' && draft?.targetId) navigate(next); else error(next === 'tools' ? t("源码目录没有 CMakeLists.txt。") : t("请选择固件目标，再完成构建设置。")); }
    } else if (data.type === 'pickedTargetScript') { draft.targetScript = data.file; draft.chipConfirmed = false;
      if (data.chipLabel) draft.chipLabel = data.chipLabel;
      if (data.scriptKind) draft.scriptKind = data.scriptKind;
      renderDraft(); changed(); }
    else if (data.type === 'navigate') { options = data.options; navigate(options.tools ? 'tools' : options.page ?? (options.setup ? 'project' : 'build')); }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing && !dirty) post('cancel'); });
  api.postMessage({ type: 'ready' });
})();
