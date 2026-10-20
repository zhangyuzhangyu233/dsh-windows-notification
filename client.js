/**
 * dsh-windows-notification — browser half (client plugin bundle).
 *
 * Two settings shells, one control surface:
 *
 * - **Old OSS runtime (dsh 0.1.x)**: a keyed card in the `settings.plugin.item`
 *   slot under the key `windows-notification`, bound to the `settingsScope`
 *   service (`ctx.settingsScope.bind({namespace})`).
 * - **Desktop runtime (0.2.x)**: a page tab in the `settings.plugins.tab` list
 *   slot inside Settings → 内置插件, shown while the Host serves the entry id
 *   `dsh-windows-notification`, bound to the `configForms` service
 *   (`ctx.configForms.get(entryId)`).
 *
 * The factory injects only the always-present core services (`slots`,
 * `locale`); each settings mode is mounted from a child fiber via
 * `ctx.inject([...])`, so exactly the mode this deployment supports activates
 * and the other waits harmlessly. All controls, strings, styles and the panel
 * body are shared; only the registration shell differs.
 *
 * Loaded by the platform client module loader: this file only registers a CJS
 * factory (`window.__ModuleLoader__.load({id, factory})`); every side effect
 * (CSS injection, slot registration) happens inside `apply`. The only runtime
 * import is the frozen platform `react` module — no bundler, no dependencies.
 *
 * Robustness contract: the UI must never throw. A missing/invalid settings
 * service, locale or slot surface degrades to an explanatory note instead of
 * breaking the plugin entry.
 */
window.__ModuleLoader__.load({
  id: 'dsh-windows-notification',
  factory(require) {
    const React = require('react');

    /** Settings namespace owned by the Host half (old-runtime slot key). */
    const NAMESPACE = 'windows-notification';
    /** Keyed card slot of the old runtime's configurable-plugins tab. */
    const CARD_SLOT = 'settings.plugin.item';
    /** Desktop-runtime settings page slot (tabs inside Settings → 内置插件). */
    const PAGE_SLOT = 'settings.plugins.tab';
    /** Loader entry id the desktop runtime keys per-plugin Config forms by. */
    const ENTRY_ID = 'dsh-windows-notification';
    /** Locale namespace owned by this bundle for the desktop settings page. */
    const LOCALE_NS = 'settings.windowsNotification';
    /** Injected stylesheet id (interactive states CSS only; layout is inline). */
    const STYLE_ID = 'dsh-windows-notification-style';
    /** Diagnostic / marker id shared by the card root and its style tag. */
    const PLUGIN_ID = 'dsh-windows-notification';

    // ------------------------------------------------ host UI channel (v1.4)
    /*
     * The Host half opens a tiny loopback HTTP UI channel next to its approval
     * bridge so the settings UI can fire a test/demo toast IMMEDIATELY instead
     * of writing a config trigger and waiting for a plugin re-apply. The port
     * is dynamic inside three candidate ranges (Windows may exclude the first
     * range on some machines) and is announced only by GET /ui/health.
     */
    /** Health response app id that proves the channel belongs to this plugin. */
    const UI_APP_ID = 'dsh-windows-notification';
    /** Candidate [first, last] port ranges the Host may bind (probed in parallel). */
    const UI_PORT_RANGES = [[49514, 49522], [49714, 49722], [48080, 48088]];
    /** Per-port health probe timeout (~250 ms per the host contract). */
    const UI_PROBE_TIMEOUT_MS = 250;
    /** Whole discovery budget; exceeded probes are abandoned for the fallback. */
    const UI_PROBE_BUDGET_MS = 1200;
    /** POST /ui/test|/ui/demo timeout before the config-write fallback. */
    const UI_POST_TIMEOUT_MS = 1500;

    // ------------------------------------------------------------------ copy
    /*
     * Bilingual copy. The card follows the active DSH locale (ctx.locale) and
     * keeps its strings local: the bundle is fetched lazily and cannot read the
     * Host's locale JSON files. The desktop runtime additionally registers the
     * same dictionaries under LOCALE_NS for the page's `label`/`t` seat.
     */
    const STRINGS = {
      zh: {
        title: 'Windows 通知',
        description: '回合完成、出错、需要批准或提问时，以 DeepSeek Harness 的身份发送 Windows 系统通知',
        statusReady: '已连接',
        statusLoading: '连接中',
        statusUnavailable: '不可用',
        statusReadOnly: '只读',
        noteLoading: '正在连接主机端设置服务…',
        noteUnavailable: '主机端没有提供 windows-notification 设置。请确认插件已在当前配置中启用（仅 Windows）。',
        noteReadOnly: '当前连接不可写入设置（浏览器进程本地模式或只读），卡片仅显示主机端当前值。',
        sectionWhen: '通知时机',
        sectionBehavior: '通知行为',
        sectionContent: '通知内容',
        sectionSound: '声音与超时',
        fieldEnabled: '启用 Windows 通知',
        fieldEnabledHint: '总开关。关闭后不再发送任何通知，也不会接管批准请求。',
        fieldOnTurnComplete: '回合完成时通知',
        fieldOnTurnCompleteHint: '助手完成一次回合时提醒。',
        fieldOnApproval: '请求批准时通知',
        fieldOnApprovalHint: '工具调用需要你批准时提醒。',
        fieldOnError: '回合出错时通知',
        fieldOnErrorHint: '回合以错误结束时提醒，并附带错误摘要。',
        fieldOnUserQuestion: '请求回答时通知',
        fieldOnUserQuestionHint: 'Agent 向你提问、需要作答时提醒。',
        fieldApprovalActions: '用通知按钮直接处理批准',
        fieldApprovalActionsHint: 'DSH 不在前台时，可以直接点击通知上的按钮批准或拒绝。',
        fieldQuestionActions: '用通知选项直接回答',
        fieldQuestionActionsHint: 'DSH 不在前台时，可直接点击通知上的选项回答提问（超时后回落到应用内提问界面）。',
        fieldQuestionTimeoutSec: '回答等待超时',
        fieldQuestionTimeoutSecHint: '超时后回落到应用内提问界面（10–600 秒）。',
        fieldSkipWhenForeground: 'DSH 在前台时静默',
        fieldSkipWhenForegroundHint: 'DeepSeek Harness 是前台窗口时不弹通知，避免打扰。',
        fieldIncludePreview: '包含回复预览',
        fieldIncludePreviewHint: '在通知正文中附带助手回复的开头内容。',
        fieldSmartSummary: '智能摘要',
        fieldSmartSummaryHint: '通知中附带用时、步数、工具调用摘要，并清理预览。',
        fieldSessionCollapse: '同会话合并通知',
        fieldSessionCollapseHint: '同一会话的新通知会替换旧通知，避免通知中心堆积。',
        fieldSound: '通知声音',
        soundDefault: '默认',
        soundSilent: '静音',
        fieldApprovalTimeoutSec: '批准等待超时',
        fieldApprovalTimeoutSecHint: '超时后回落到应用内批准弹窗（5–300 秒）。',
        fieldMaxPreviewChars: '预览长度上限',
        fieldMaxPreviewCharsHint: '通知正文中的预览字符数（40–500）。',
        unitSeconds: '秒',
        unitChars: '字符',
        sectionDemo: '演示',
        fieldDemoKind: '演示选项',
        fieldDemoKindHint: '选择「发送演示通知」要演示的通知类型。',
        demoKindComplete: '完成通知',
        demoKindApproval: '审批通知',
        demoKindQuestionOptions: '提问·选项',
        demoKindQuestionText: '提问·文本',
        demo: '发送演示通知',
        demoSent: '已发送演示通知',
        demoSentUnconfirmed: '已发送演示通知（未确认回执）',
        fieldDemoPingHint: '按所选类型立即发送一条示例通知（不会创建真实审批或提问）。',
        fieldTestPing: '测试通知',
        fieldTestPingHint: '立即发送一条测试通知，验证 Windows 通知通道是否可用。',
        test: '发送测试通知',
        testSent: '已发送测试通知',
        testSentUnconfirmed: '已发送测试通知（未确认回执）',
        reset: '恢复默认',
        resetHint: '把本卡片的全部选项恢复为插件默认值。',
        errorPrefix: '卡片渲染失败：',
      },
      en: {
        title: 'Windows Notification',
        description: 'Native Windows toasts under the DeepSeek Harness identity when a turn completes, fails, needs approval, or asks a question',
        statusReady: 'Connected',
        statusLoading: 'Connecting',
        statusUnavailable: 'Unavailable',
        statusReadOnly: 'Read-only',
        noteLoading: 'Connecting to the host settings service…',
        noteUnavailable: 'The Host does not serve the windows-notification settings. Make sure the plugin is enabled in this composition (Windows only).',
        noteReadOnly: 'This connection cannot write settings (process-local or read-only); the card only shows the Host values.',
        sectionWhen: 'When to notify',
        sectionBehavior: 'Behaviour',
        sectionContent: 'Content',
        sectionSound: 'Sound & timeout',
        sectionDemo: 'Demo',
        fieldEnabled: 'Enable Windows notifications',
        fieldEnabledHint: 'Master switch. When off, no toasts are posted and approvals are never claimed.',
        fieldOnTurnComplete: 'Notify when a turn completes',
        fieldOnTurnCompleteHint: 'Alert when the assistant finishes a turn.',
        fieldOnApproval: 'Notify when approval is requested',
        fieldOnApprovalHint: 'Alert when a tool call needs your approval.',
        fieldOnError: 'Notify when a turn fails',
        fieldOnErrorHint: 'Alert when a turn ends in an error, with a short error summary.',
        fieldOnUserQuestion: 'Notify when the agent asks a question',
        fieldOnUserQuestionHint: 'Alert when the agent needs an answer from you.',
        fieldApprovalActions: 'Handle approvals from the toast',
        fieldApprovalActionsHint: 'While DSH is not foreground, approve or reject with the toast buttons.',
        fieldQuestionActions: 'Answer questions from the toast',
        fieldQuestionActionsHint: 'While DSH is not foreground, answer a question with the toast options (falls back to the in-app question on timeout).',
        fieldQuestionTimeoutSec: 'Question wait timeout',
        fieldQuestionTimeoutSecHint: 'Fall back to the in-app question UI after this many seconds (10–600).',
        fieldSkipWhenForeground: 'Stay silent while DSH is foreground',
        fieldSkipWhenForegroundHint: 'Do not toast while the DeepSeek Harness window is focused.',
        fieldIncludePreview: 'Include a reply preview',
        fieldIncludePreviewHint: 'Append the beginning of the assistant reply to the toast body.',
        fieldSmartSummary: 'Smart summary',
        fieldSmartSummaryHint: 'Add duration, step and tool-call details to the toast and clean up the reply preview.',
        fieldSessionCollapse: 'Collapse per session',
        fieldSessionCollapseHint: 'A newer notification for the same session replaces the older one instead of stacking up.',
        fieldSound: 'Toast sound',
        soundDefault: 'Default',
        soundSilent: 'Silent',
        fieldApprovalTimeoutSec: 'Approval wait timeout',
        fieldApprovalTimeoutSecHint: 'Fall back to the in-app approval prompt after this many seconds (5–300).',
        fieldMaxPreviewChars: 'Preview length limit',
        fieldMaxPreviewCharsHint: 'Characters of reply preview included in the toast body (40–500).',
        unitSeconds: 's',
        unitChars: 'chars',
        fieldDemoKind: 'Demo option',
        fieldDemoKindHint: 'Which notification type the demo button fires.',
        demoKindComplete: 'Turn complete',
        demoKindApproval: 'Approval',
        demoKindQuestionOptions: 'Question (options)',
        demoKindQuestionText: 'Question (free text)',
        demo: 'Send demo notification',
        demoSent: 'Demo notification sent',
        demoSentUnconfirmed: 'Demo notification sent (receipt unconfirmed)',
        fieldDemoPingHint: 'Posts a sample notification of the selected kind right now (no real approval or question is created).',
        fieldTestPing: 'Test notification',
        fieldTestPingHint: 'Post one test toast now to check the Windows notification channel.',
        test: 'Send test notification',
        testSent: 'Test notification sent',
        testSentUnconfirmed: 'Test notification sent (receipt unconfirmed)',
        reset: 'Restore defaults',
        resetHint: 'Reset every option on this card to the plugin defaults.',
        errorPrefix: 'Card failed to render: ',
      },
    };

    /** Active UI language: `zh` or `en` (zh is the deployment default). */
    let lang = 'zh';
    const langListeners = new Set();

    /**
     * Normalize whatever `ctx.locale.getLocale()` returns (a LocaleSnapshot or
     * a bare id) into the UI's two-language vocabulary.
     * @param {unknown} value - locale snapshot / id.
     * @returns {'zh'|'en'} active language.
     */
    function detectLang(value) {
      let id = '';
      if (typeof value === 'string') {
        id = value;
      } else if (value && typeof value === 'object') {
        const active = value.active;
        if (typeof active === 'string') id = active;
        else if (active && typeof active === 'object') {
          id = String(active.id || active.locale || active.language || '');
        } else {
          id = String(value.id || value.locale || value.language || '');
        }
      }
      return String(id).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
    }

    /** Translate one UI string, preferring the active language then zh. */
    function translate(key, params) {
      const table = STRINGS[lang] || STRINGS.zh;
      let text = table[key];
      if (text === undefined) text = STRINGS.zh[key];
      if (text === undefined) return String(key);
      if (params) {
        text = text.replace(/\{(\w+)\}/g, function (match, name) {
          return params[name] === undefined ? match : String(params[name]);
        });
      }
      return text;
    }

    function subscribeLang(listener) {
      langListeners.add(listener);
      return function () { langListeners.delete(listener); };
    }

    function getLangSnapshot() { return lang; }

    /** Re-render the UI when the deployment language changes. */
    function useLang() {
      return React.useSyncExternalStore(subscribeLang, getLangSnapshot, getLangSnapshot);
    }

    /** Keep the module language in sync with the ctx locale face (never throws). */
    function syncLang(ctx) {
      let next = lang;
      try {
        if (ctx && ctx.locale && typeof ctx.locale.getLocale === 'function') {
          next = detectLang(ctx.locale.getLocale());
        }
      } catch (error) {
        next = lang;
      }
      if (next !== lang) {
        lang = next;
        langListeners.forEach(function (listener) {
          try { listener(); } catch (error) { /* one broken listener must not veto the rest */ }
        });
      }
    }

    function logFailure(message, error) {
      try {
        if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
          console.warn('[' + PLUGIN_ID + '] ' + message, error);
        }
      } catch (ignored) { /* logging is best effort */ }
    }

    // ------------------------------------------------------- host UI channel
    /** Last discovered host UI port (0 = unknown / reset). */
    let uiPortCache = 0;
    /** In-flight discovery shared by concurrent clicks (null = idle). */
    let uiProbeInFlight = null;

    function canFetch() {
      return typeof fetch === 'function';
    }

    /** Abort a controller without letting an abort race escape. */
    function abortQuietly(controller) {
      if (!controller) return;
      try { controller.abort(); } catch (error) { /* abort races are not failures */ }
    }

    /** Resolve `promise` with `fallback` unless it settles within `ms`. */
    function withProbeTimeout(promise, ms, fallback) {
      return new Promise(function (resolve) {
        let settled = false;
        const timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          resolve(fallback);
        }, ms);
        promise.then(function (value) {
          if (settled) return;
          settled = true;
          try { clearTimeout(timer); } catch (error) { /* timer cleanup */ }
          resolve(value);
        }, function () {
          if (settled) return;
          settled = true;
          try { clearTimeout(timer); } catch (error) { /* timer cleanup */ }
          resolve(fallback);
        });
      });
    }

    /**
     * Probe one candidate port's GET /ui/health.
     * @param {number} port - loopback port to probe.
     * @param {AbortSignal|undefined} signal - shared discovery abort signal.
     * @returns {Promise<boolean>} whether the plugin's UI channel answers.
     */
    function probeUiPort(port, signal) {
      let request;
      try {
        request = fetch('http://127.0.0.1:' + port + '/ui/health', {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: signal,
        }).then(function (response) {
          if (!response || !response.ok) return false;
          return response.json().then(function (body) {
            return Boolean(body && body.app === UI_APP_ID);
          }, function () { return false; });
        }, function () { return false; });
      } catch (error) {
        return Promise.resolve(false);
      }
      return withProbeTimeout(request, UI_PROBE_TIMEOUT_MS, false);
    }

    /**
     * Discover the host UI channel port, caching it for later clicks.
     * @returns {Promise<number>} discovered port, or 0 when unavailable.
     */
    function discoverUiPort() {
      if (uiPortCache !== 0) return Promise.resolve(uiPortCache);
      if (uiProbeInFlight !== null) return uiProbeInFlight;
      if (!canFetch()) return Promise.resolve(0);
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const signal = controller ? controller.signal : undefined;
      const ports = [];
      for (let rangeIndex = 0; rangeIndex < UI_PORT_RANGES.length; rangeIndex += 1) {
        const range = UI_PORT_RANGES[rangeIndex];
        for (let port = range[0]; port <= range[1]; port += 1) ports.push(port);
      }
      const probes = ports.map(function (port) { return probeUiPort(port, signal); });
      uiProbeInFlight = new Promise(function (resolve) {
        let finished = false;
        function settle(port) {
          if (finished) return;
          finished = true;
          uiProbeInFlight = null;
          uiPortCache = port || 0;
          abortQuietly(controller);
          resolve(uiPortCache);
        }
        const budget = setTimeout(function () { settle(0); }, UI_PROBE_BUDGET_MS);
        let remaining = probes.length;
        probes.forEach(function (probe, index) {
          probe.then(function (accepted) {
            if (finished) return;
            if (accepted) {
              try { clearTimeout(budget); } catch (error) { /* timer cleanup */ }
              settle(ports[index]);
              return;
            }
            remaining -= 1;
            if (remaining === 0) {
              try { clearTimeout(budget); } catch (error) { /* timer cleanup */ }
              settle(0);
            }
          }, function () {
            if (finished) return;
            remaining -= 1;
            if (remaining === 0) {
              try { clearTimeout(budget); } catch (error) { /* timer cleanup */ }
              settle(0);
            }
          });
        });
      });
      return uiProbeInFlight;
    }

    /**
     * POST one instant trigger to a known host UI port with readable CORS.
     * @param {number} port - discovered host UI port.
     * @param {string} route - `test` or `demo` (the `/ui/` suffix).
     * @param {object} [body] - JSON body (`{kind}` for demo).
     * @returns {Promise<boolean>} whether the host accepted the trigger.
     */
    function postUiTriggerOnPort(port, route, body) {
      if (!canFetch() || !port) return Promise.resolve(false);
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const signal = controller ? controller.signal : undefined;
      let request;
      try {
        request = fetch('http://127.0.0.1:' + port + '/ui/' + route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
          cache: 'no-store',
          signal: signal,
        }).then(function (response) {
          return Boolean(response && response.ok);
        }, function () { return false; });
      } catch (error) {
        request = Promise.resolve(false);
      }
      return withProbeTimeout(request, UI_POST_TIMEOUT_MS, false).then(function (delivered) {
        abortQuietly(controller);
        return delivered;
      });
    }

    /**
     * Last-resort CORS bypass: a `no-cors` simple POST with a text/plain body.
     * The browser cannot read the opaque response, so a resolved request is
     * reported as "sent (unconfirmed)" — used when the desktop renderer origin
     * (`dsh-app://app`) is rejected by the host's CORS allowlist.
     * @param {number} port - host UI port to notify.
     * @param {string} route - `test` or `demo`.
     * @param {string} bodyText - already-serialized JSON body.
     * @returns {Promise<boolean>} whether the beacon request left the page.
     */
    function beaconUiTriggerOnPort(port, route, bodyText) {
      if (!canFetch() || !port) return Promise.resolve(false);
      let request;
      try {
        request = fetch('http://127.0.0.1:' + port + '/ui/' + route, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'content-type': 'text/plain' },
          body: bodyText,
          cache: 'no-store',
        }).then(function () { return true; }, function () { return false; });
      } catch (error) {
        return Promise.resolve(false);
      }
      return withProbeTimeout(request, UI_POST_TIMEOUT_MS, false);
    }

    /**
     * Find a listening host UI port without readable CORS (opaque `no-cors`
     * GET resolutions). Only used when the normal health discovery is blocked.
     * @returns {Promise<number>} port, or 0 when nothing answers.
     */
    function discoverUiPortNoCors() {
      if (!canFetch()) return Promise.resolve(0);
      const ports = [];
      for (let rangeIndex = 0; rangeIndex < UI_PORT_RANGES.length; rangeIndex += 1) {
        const range = UI_PORT_RANGES[rangeIndex];
        for (let port = range[0]; port <= range[1]; port += 1) ports.push(port);
      }
      return new Promise(function (resolve) {
        let finished = false;
        function settle(port) {
          if (finished) return;
          finished = true;
          if (port) uiPortCache = port;
          resolve(port || 0);
        }
        const budget = setTimeout(function () { settle(0); }, UI_PROBE_BUDGET_MS);
        let remaining = ports.length;
        ports.forEach(function (port) {
          let probe;
          try {
            probe = fetch('http://127.0.0.1:' + port + '/ui/health', {
              method: 'GET',
              mode: 'no-cors',
              cache: 'no-store',
            }).then(function () { return true; }, function () { return false; });
          } catch (error) {
            probe = Promise.resolve(false);
          }
          withProbeTimeout(probe, UI_PROBE_TIMEOUT_MS, false).then(function (listening) {
            if (finished) return;
            if (listening) {
              try { clearTimeout(budget); } catch (error) { /* timer cleanup */ }
              settle(port);
              return;
            }
            remaining -= 1;
            if (remaining === 0) {
              try { clearTimeout(budget); } catch (error) { /* timer cleanup */ }
              settle(0);
            }
          });
        });
      });
    }

    /**
     * Last-resort delivery: beacon to the cached port, else discover a listening
     * port with opaque probes and beacon there.
     * @param {string} route - `test` or `demo`.
     * @param {string} bodyText - serialized JSON body.
     * @returns {Promise<'unconfirmed'|'failed'>} delivery outcome.
     */
    function beaconUiTrigger(route, bodyText) {
      const send = function (port) {
        return beaconUiTriggerOnPort(port, route, bodyText).then(function (sent) {
          return sent ? 'unconfirmed' : 'failed';
        });
      };
      if (uiPortCache !== 0) {
        return send(uiPortCache).then(function (outcome) {
          if (outcome === 'unconfirmed') return outcome;
          uiPortCache = 0;
          return discoverUiPortNoCors().then(function (port) {
            return port ? send(port) : 'failed';
          });
        });
      }
      return discoverUiPortNoCors().then(function (port) {
        return port ? send(port) : 'failed';
      });
    }

    /**
     * Deliver one instant trigger: readable CORS POST first, then the no-cors
     * beacon, then report failure so the caller can write the config trigger.
     * @param {string} route - `test` or `demo`.
     * @param {object} [body] - JSON body (`{kind}` for demo).
     * @returns {Promise<'confirmed'|'unconfirmed'|'failed'>} delivery outcome.
     */
    function deliverUiTrigger(route, body) {
      if (!canFetch()) return Promise.resolve('failed');
      const bodyText = JSON.stringify(body || {});
      return discoverUiPort().then(function (port) {
        if (!port) return beaconUiTrigger(route, bodyText);
        return postUiTriggerOnPort(port, route, body).then(function (delivered) {
          if (delivered) return 'confirmed';
          // POST failed; a beacon to the same port can still reach a host whose
          // CORS allowlist rejects this page origin.
          uiPortCache = 0;
          return beaconUiTriggerOnPort(port, route, bodyText).then(function (sent) {
            return sent ? 'unconfirmed' : beaconUiTrigger(route, bodyText);
          });
        });
      }, function () {
        return beaconUiTrigger(route, bodyText);
      });
    }

    // ----------------------------------------------------- settings contract
    /*
     * Mirror of the Host schema, kept here only as a UI/runtime fallback: the
     * UI renders `snapshot.value` (already schema-resolved by the Host) and
     * these defaults only cover a snapshot that has not arrived yet.
     */
    /** Boolean switches, in display order (1 master switch + 10 sub-switches). */
    const TOGGLE_FIELDS = [
      'enabled',
      'onTurnComplete',
      'onApproval',
      'onError',
      'onUserQuestion',
      'approvalActions',
      'questionActions',
      'skipWhenForeground',
      'includePreview',
      'smartSummary',
      'sessionCollapse',
    ];
    /** Sound enum values accepted by the Host schema. */
    const SOUND_VALUES = ['default', 'silent'];
    /** Demo notification kinds; values match the Host schema's `demoKind` union. */
    const DEMO_KINDS = ['complete', 'approval', 'question-options', 'question-text'];
    /** Default `demoKind` while the first resolved snapshot has not arrived. */
    const DEMO_DEFAULT = 'question-options';
    /** Integer fields with their Host schema bounds. */
    const NUMBER_FIELDS = {
      approvalTimeoutSec: { min: 5, max: 300, unitKey: 'unitSeconds' },
      maxPreviewChars: { min: 40, max: 500, unitKey: 'unitChars' },
      questionTimeoutSec: { min: 10, max: 600, unitKey: 'unitSeconds' },
    };
    /** Integer defaults used until the first resolved snapshot arrives. */
    const NUMBER_DEFAULTS = {
      approvalTimeoutSec: 30,
      maxPreviewChars: 180,
      questionTimeoutSec: 60,
    };
    /** Every configurable user field, cleared by "restore defaults" (16 fields). */
    const RESET_FIELDS = [
      'enabled',
      'onTurnComplete',
      'onApproval',
      'onError',
      'onUserQuestion',
      'approvalActions',
      'questionActions',
      'questionTimeoutSec',
      'skipWhenForeground',
      'includePreview',
      'smartSummary',
      'sessionCollapse',
      'maxPreviewChars',
      'sound',
      'approvalTimeoutSec',
      'demoKind',
    ];
    /** Write-only trigger field: a new epoch ms asks the Host for a test toast. */
    const TEST_FIELD = 'testPing';
    /** Write-only trigger field: a new epoch ms asks the Host for a demo toast. */
    const DEMO_PING_FIELD = 'demoPing';
    /** Persisted demo selector field (which demo notification the trigger fires). */
    const DEMO_KIND_FIELD = 'demoKind';

    /** Boolean defaults used until the first resolved snapshot arrives. */
    const BOOL_DEFAULTS = {
      enabled: true,
      onTurnComplete: true,
      onApproval: true,
      onError: true,
      onUserQuestion: true,
      skipWhenForeground: true,
      includePreview: true,
      smartSummary: true,
      sessionCollapse: true,
      approvalActions: true,
      questionActions: true,
    };

    function labelKeyOf(field) {
      return 'field' + field.charAt(0).toUpperCase() + field.slice(1);
    }

    function readBool(value, field) {
      if (value && typeof value === 'object' && typeof value[field] === 'boolean') return value[field];
      return BOOL_DEFAULTS[field] !== false;
    }

    function readNumber(value, field) {
      const spec = NUMBER_FIELDS[field];
      if (value && typeof value === 'object') {
        const raw = value[field];
        if (typeof raw === 'number' && isFinite(raw)) return Math.min(spec.max, Math.max(spec.min, Math.round(raw)));
      }
      return NUMBER_DEFAULTS[field] !== undefined ? NUMBER_DEFAULTS[field] : 0;
    }

    function readSound(value) {
      const raw = value && typeof value === 'object' ? value.sound : undefined;
      return SOUND_VALUES.indexOf(raw) === -1 ? 'default' : raw;
    }

    function readDemoKind(value) {
      const raw = value && typeof value === 'object' ? value.demoKind : undefined;
      return DEMO_KINDS.indexOf(raw) === -1 ? DEMO_DEFAULT : raw;
    }

    // ------------------------------------------------------------ style kit
    /** Dimensions/typography shared by every control (inline styles). */
    const S = {
      card: { listStyle: 'none', margin: '0', color: 'var(--dsw-alias-label-primary, #f5f6f7)', fontSize: '13px', lineHeight: '1.5', overflow: 'hidden', textAlign: 'left' },
      header: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px 16px' },
      headText: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 auto', minWidth: '0' },
      name: { fontSize: '15px', fontWeight: 600, lineHeight: '1.4', color: 'var(--dsw-alias-label-primary, #f5f6f7)' },
      page: { display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', maxWidth: '760px', color: 'var(--dsw-alias-label-primary, #f5f6f7)', fontSize: '13px', lineHeight: '1.5' },
      pageTitle: { fontSize: '18px', fontWeight: 600, lineHeight: '1.4', color: 'var(--dsw-alias-label-primary, #f5f6f7)' },
      description: { fontSize: '13px', lineHeight: '1.5', color: 'var(--dsw-alias-label-tertiary, #a0a4ad)' },
      pill: { flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '1px 8px', borderRadius: '999px', background: 'var(--dsw-alias-bg-module-platform, rgba(255,255,255,.08))', color: 'var(--dsw-alias-label-secondary, #c5c8ce)', fontSize: '11px', fontWeight: 500, lineHeight: '17px', whiteSpace: 'nowrap' },
      dot: { display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto' },
      body: { display: 'flex', flexDirection: 'column', margin: '0 16px', padding: '10px 0 12px', borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))' },
      section: { margin: '10px 0 0', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-caption, #6c727d)' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '7px 0' },
      rowText: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: '0' },
      label: { fontSize: '13px', lineHeight: '1.4', color: 'var(--dsw-alias-label-primary, #f5f6f7)' },
      hint: { fontSize: '11.5px', lineHeight: '1.45', color: 'var(--dsw-alias-label-tertiary, #a0a4ad)' },
      note: { margin: '8px 0 0', padding: '8px 10px', borderRadius: '10px', background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))', color: 'var(--dsw-alias-label-secondary, #c5c8ce)', fontSize: '12px', lineHeight: '1.5' },
      footer: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', flexWrap: 'wrap' },
      demoRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', flexWrap: 'wrap' },
      footerHint: { marginTop: '8px', fontSize: '11.5px', lineHeight: '1.45', color: 'var(--dsw-alias-label-tertiary, #a0a4ad)' },
      primaryButton: { appearance: 'none', WebkitAppearance: 'none', border: '0', borderRadius: '8px', padding: '5px 14px', fontSize: '13px', lineHeight: '1.5', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary-foreground, #17181a)' },
      ghostButton: { appearance: 'none', WebkitAppearance: 'none', border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))', borderRadius: '8px', padding: '5px 14px', fontSize: '13px', lineHeight: '1.5', fontFamily: 'inherit', color: 'var(--dsw-alias-label-secondary, #c5c8ce)' },
      sentNote: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #3fbf7f)' },
      numberWrap: { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' },
      input: { boxSizing: 'border-box', width: '76px', padding: '4px 8px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))', background: 'var(--dsw-alias-bg-base, #17181a)', color: 'var(--dsw-alias-label-primary, #f5f6f7)', fontSize: '13px', lineHeight: '1.5', fontFamily: 'inherit', textAlign: 'right', colorScheme: 'dark' },
      select: { maxWidth: '150px', padding: '4px 8px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))', background: 'var(--dsw-alias-bg-base, #17181a)', color: 'var(--dsw-alias-label-primary, #f5f6f7)', fontSize: '13px', lineHeight: '1.5', fontFamily: 'inherit', colorScheme: 'dark' },
      unit: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #a0a4ad)' },
    };

    /**
     * Interactive states that inline styles cannot express (hover/focus rings,
     * native <option> colors). Layout stays inline; this sheet is polish only.
     */
    const CSS = [
      '.dsh-wn-card{list-style:none;border:0.5px solid var(--dsw-alias-border-l4, #ffffff33);background:var(--dsw-alias-bg-layer-3, #2b2d33);border-radius:16px;transition:border-color .16s,background .16s}',
      '.dsh-wn-card:hover{border-color:var(--dsw-alias-label-dimmed, rgba(255,255,255,.4))}',
      '.dsh-wn-card .dsh-wn-switch{appearance:none;-webkit-appearance:none;padding:0;cursor:pointer}',
      '.dsh-wn-card .dsh-wn-switch:not(:disabled):hover{filter:brightness(1.1)}',
      '.dsh-wn-card .dsh-wn-btn{cursor:pointer}',
      '.dsh-wn-card .dsh-wn-btn-primary{background:var(--dsw-alias-button-primary-fill, #f5f6f7)}',
      '.dsh-wn-card .dsh-wn-btn-ghost{background:transparent}',
      '.dsh-wn-card .dsh-wn-btn:disabled,',
      '.dsh-wn-card .dsh-wn-switch:disabled,',
      '.dsh-wn-card .dsh-wn-select:disabled,',
      '.dsh-wn-card .dsh-wn-input:disabled{cursor:default;opacity:.55}',
      '.dsh-wn-card .dsh-wn-btn:focus-visible,',
      '.dsh-wn-card .dsh-wn-switch:focus-visible,',
      '.dsh-wn-card .dsh-wn-select:focus-visible,',
      '.dsh-wn-card .dsh-wn-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary, #4d6bfe);outline-offset:2px}',
      '.dsh-wn-card .dsh-wn-btn-primary:not(:disabled):hover{background:var(--dsw-alias-button-primary-hover, #e8e9ec)}',
      '.dsh-wn-card .dsh-wn-btn-ghost:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))}',
      '.dsh-wn-card .dsh-wn-select option{background:var(--dsw-alias-bg-layer-2, #232529);color:var(--dsw-alias-label-primary, #f5f6f7)}',
    ].join('\n');

    function ensureStyle() {
      try {
        if (typeof document === 'undefined' || !document || !document.head) return;
        if (document.getElementById(STYLE_ID) !== null) return;
        const tag = document.createElement('style');
        tag.id = STYLE_ID;
        tag.setAttribute('data-plugin', PLUGIN_ID);
        tag.setAttribute('data-plugin-css', PLUGIN_ID + '/card');
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (error) {
        logFailure('style injection failed', error);
      }
    }

    function removeStyle() {
      try {
        if (typeof document === 'undefined' || !document) return;
        const tag = document.getElementById(STYLE_ID);
        if (tag !== null) tag.remove();
      } catch (error) { /* teardown is best effort */ }
    }

    // --------------------------------------------------------- element utils
    /** Flat createElement: array children are expanded into positional ones. */
    function h(type, props) {
      const children = [];
      for (let index = 2; index < arguments.length; index += 1) {
        const child = arguments[index];
        if (Array.isArray(child)) {
          for (let inner = 0; inner < child.length; inner += 1) children.push(child[inner]);
        } else {
          children.push(child);
        }
      }
      return React.createElement.apply(React, [type, props || null].concat(children));
    }

    function rowText(label, hint) {
      return h('div', { style: S.rowText },
        h('div', { style: S.label }, label),
        hint ? h('div', { style: S.hint }, hint) : null);
    }

    // ------------------------------------------------------ scope access seam
    /*
     * A stable, never-throwing view over the injected settings scope (old
     * runtime `settingsScope` or desktop runtime `configForms.get`). A missing
     * or broken scope becomes a constant "unavailable" snapshot so hooks keep
     * their unconditional call order and the UI still renders.
     */
    const FALLBACK_SNAPSHOT = {
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'memory',
    };
    const FALLBACK_ACCESS = {
      subscribe: function () { return function () { }; },
      getSnapshot: function () { return FALLBACK_SNAPSHOT; },
    };

    function createStoreAccess(scope) {
      if (!scope || typeof scope.getSnapshot !== 'function' || typeof scope.subscribe !== 'function') {
        return FALLBACK_ACCESS;
      }
      return {
        subscribe: function (listener) {
          try {
            const unsubscribe = scope.subscribe(listener);
            return typeof unsubscribe === 'function' ? unsubscribe : function () { };
          } catch (error) {
            logFailure('settings scope subscribe failed', error);
            return function () { };
          }
        },
        getSnapshot: function () {
          try {
            const snapshot = scope.getSnapshot();
            return snapshot && typeof snapshot === 'object' ? snapshot : FALLBACK_SNAPSHOT;
          } catch (error) {
            logFailure('settings scope snapshot failed', error);
            return FALLBACK_SNAPSHOT;
          }
        },
      };
    }

    // -------------------------------------------------------------- controls
    /** One boolean row with the DSH-style switch on the trailing edge. */
    function ToggleRow(props) {
      const on = props.value === true;
      const disabled = props.disabled === true;
      return h('div', { style: S.row, 'data-field': props.field },
        rowText(props.label, props.hint),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': props.label,
          'data-toggle': props.field,
          disabled: disabled,
          className: 'dsh-wn-switch',
          onClick: function () { if (!disabled) props.onChange(!on); },
          style: {
            position: 'relative',
            flex: '0 0 auto',
            width: '36px',
            height: '20px',
            borderRadius: '10px',
            border: '0',
            background: on
              ? 'var(--dsw-alias-state-business-primary, #4d6bfe)'
              : 'rgba(127,127,127,.35)',
            cursor: disabled ? 'default' : 'pointer',
            transition: 'background .16s',
          },
        }, h('span', {
          style: {
            position: 'absolute',
            top: '2px',
            left: '2px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            background: '#fff',
            transform: on ? 'translateX(16px)' : 'none',
            transition: 'transform .16s',
          },
        })));
    }

    /** One enum row rendered as a native select over the supplied option list. */
    function SelectRow(props) {
      const disabled = props.disabled === true;
      const options = Array.isArray(props.options) ? props.options : [];
      const optionElements = [];
      for (let index = 0; index < options.length; index += 1) {
        optionElements.push(h('option', { key: options[index].value, value: options[index].value }, options[index].label));
      }
      return h('div', { style: S.row, 'data-field': props.field },
        rowText(props.label, props.hint),
        h('select', {
          'aria-label': props.label,
          'data-select': props.field,
          value: props.value,
          disabled: disabled,
          className: 'dsh-wn-select',
          onChange: function (event) {
            if (!disabled) props.onChange(event.target.value);
          },
          style: S.select,
        },
        optionElements));
    }

    /**
     * One bounded integer row. Edits stay local until blur / Enter so a
     * half-typed number never reaches the Host; commits clamp into the schema
     * bounds and write only on a real change.
     */
    function NumberRow(props) {
      const spec = NUMBER_FIELDS[props.field];
      const min = spec ? spec.min : 0;
      const max = spec ? spec.max : 1000;
      const value = props.value;
      const disabled = props.disabled === true;
      const [text, setText] = React.useState(typeof value === 'number' ? String(value) : '');
      React.useEffect(function () {
        setText(typeof value === 'number' && isFinite(value) ? String(value) : '');
      }, [value]);
      const commit = function () {
        const parsed = parseInt(String(text).trim(), 10);
        if (!isFinite(parsed)) {
          setText(typeof value === 'number' ? String(value) : '');
          return;
        }
        const clamped = Math.min(max, Math.max(min, parsed));
        setText(String(clamped));
        if (clamped !== value) props.onCommit(clamped);
      };
      return h('div', { style: S.row, 'data-field': props.field },
        rowText(props.label, props.hint),
        h('div', { style: S.numberWrap },
          h('input', {
            type: 'number',
            min: min,
            max: max,
            step: 1,
            value: text,
            disabled: disabled,
            'aria-label': props.label,
            'data-number': props.field,
            className: 'dsh-wn-input',
            onChange: function (event) { setText(event.target.value); },
            onBlur: function () { if (!disabled) commit(); },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                if (typeof event.preventDefault === 'function') event.preventDefault();
                if (!disabled) commit();
              }
            },
            style: S.input,
          }),
          h('span', { style: S.unit }, props.unit)));
    }

    // ----------------------------------------------------------- panel model
    /**
     * Shared hook model behind both registration shells: one settings
     * subscription (old `settingsScope` scope or desktop `configForms` entry
     * form), one set of local interaction states, one write surface.
     * @param {object} rawProps - injected face `{ scope, t }`.
     * @returns {object} panel model consumed by the shell builders.
     */
    function usePanelModel(rawProps) {
      useLang();
      const props = rawProps && typeof rawProps === 'object' ? rawProps : {};
      const scope = props.scope;
      const t = typeof props.t === 'function' ? props.t : translate;
      const access = React.useMemo(function () { return createStoreAccess(scope); }, [scope]);
      const snapshot = React.useSyncExternalStore(access.subscribe, access.getSnapshot, access.getSnapshot);
      const [testFeedback, setTestFeedback] = React.useState('');
      const pingTimer = React.useRef(0);
      React.useEffect(function () {
        return function () {
          try {
            if (pingTimer.current && typeof clearTimeout === 'function') clearTimeout(pingTimer.current);
            pingTimer.current = 0;
          } catch (error) { /* timer cleanup is best effort */ }
        };
      }, []);

      const status = snapshot && typeof snapshot.status === 'string' ? snapshot.status : 'unavailable';
      const ready = status === 'ready';
      const writable = ready && snapshot.writable !== false;
      const value = ready && snapshot.value && typeof snapshot.value === 'object' ? snapshot.value : {};

      // Demo selector: keep the visually chosen kind locally so the trigger
      // writes the selection the user sees even before the snapshot round-trips.
      const demoValue = readDemoKind(value);
      const [demoSelection, setDemoSelection] = React.useState(demoValue);
      const [demoFeedback, setDemoFeedback] = React.useState('');
      const demoTimer = React.useRef(0);
      React.useEffect(function () {
        setDemoSelection(demoValue);
      }, [demoValue]);
      React.useEffect(function () {
        return function () {
          try {
            if (demoTimer.current && typeof clearTimeout === 'function') clearTimeout(demoTimer.current);
            demoTimer.current = 0;
          } catch (error) { /* timer cleanup is best effort */ }
        };
      }, []);

      const write = function (field, next) {
        if (!writable || !scope || typeof scope.set !== 'function') return;
        try {
          const pending = scope.set(field, next);
          if (pending && typeof pending.catch === 'function') pending.catch(function (error) { logFailure('settings write failed: ' + field, error); });
        } catch (error) {
          logFailure('settings write threw: ' + field, error);
        }
      };
      const clearFields = function () {
        if (!writable || !scope || typeof scope.unset !== 'function') return;
        for (let index = 0; index < RESET_FIELDS.length; index += 1) {
          const field = RESET_FIELDS[index];
          try {
            const pending = scope.unset(field);
            if (pending && typeof pending.catch === 'function') pending.catch(function (error) { logFailure('settings reset failed: ' + field, error); });
          } catch (error) {
            logFailure('settings reset threw: ' + field, error);
          }
        }
      };
      const showTestFeedback = function (kind) {
        setTestFeedback(kind || '');
        try {
          if (typeof setTimeout === 'function') {
            if (pingTimer.current && typeof clearTimeout === 'function') clearTimeout(pingTimer.current);
            pingTimer.current = setTimeout(function () { setTestFeedback(''); }, 2600);
          }
        } catch (error) { /* feedback is cosmetic */ }
      };
      const showDemoFeedback = function (kind) {
        setDemoFeedback(kind || '');
        try {
          if (typeof setTimeout === 'function') {
            if (demoTimer.current && typeof clearTimeout === 'function') clearTimeout(demoTimer.current);
            demoTimer.current = setTimeout(function () { setDemoFeedback(''); }, 2600);
          }
        } catch (error) { /* feedback is cosmetic */ }
      };
      const sendTestPing = function () {
        // Optimistic feedback, then the instant host UI channel: readable CORS
        // POST (confirmed), no-cors beacon (sent, unconfirmed), and only when
        // both fail the config trigger that needs a plugin re-apply.
        showTestFeedback('sent');
        const fallback = function () {
          write(TEST_FIELD, Date.now());
          showTestFeedback('sent');
        };
        if (!canFetch()) {
          fallback();
          return;
        }
        try {
          deliverUiTrigger('test', {}).then(function (outcome) {
            if (outcome === 'confirmed') showTestFeedback('sent');
            else if (outcome === 'unconfirmed') showTestFeedback('unconfirmed');
            else fallback();
          }, fallback);
        } catch (error) {
          fallback();
        }
      };
      const sendDemoPing = function () {
        showDemoFeedback('sent');
        const kind = demoSelection;
        const fallback = function () {
          // Persist the visible selection first, then bump the write-only trigger.
          write(DEMO_KIND_FIELD, kind);
          write(DEMO_PING_FIELD, Date.now());
          showDemoFeedback('sent');
        };
        if (!canFetch()) {
          fallback();
          return;
        }
        try {
          deliverUiTrigger('demo', { kind: kind }).then(function (outcome) {
            if (outcome === 'confirmed') showDemoFeedback('sent');
            else if (outcome === 'unconfirmed') showDemoFeedback('unconfirmed');
            else fallback();
          }, fallback);
        } catch (error) {
          fallback();
        }
      };

      return {
        t: t,
        status: status,
        ready: ready,
        writable: writable,
        value: value,
        demoSelection: demoSelection,
        demoFeedback: demoFeedback,
        testFeedback: testFeedback,
        write: write,
        clearFields: clearFields,
        sendTestPing: sendTestPing,
        sendDemoPing: sendDemoPing,
        setDemoSelection: setDemoSelection,
      };
    }

    /** Title/description/status-pill header shared by the card and the page. */
    function buildPanelHeader(model, page) {
      const t = model.t;
      const status = model.status;
      const statusInfo = status === 'ready'
        ? { key: model.writable ? 'statusReady' : 'statusReadOnly', color: model.writable ? 'var(--dsw-alias-state-success-primary, #3fbf7f)' : 'var(--dsw-alias-state-warn-primary, #e2a33c)' }
        : status === 'loading'
          ? { key: 'statusLoading', color: 'var(--dsw-alias-state-warn-primary, #e2a33c)' }
          : { key: 'statusUnavailable', color: 'var(--dsw-alias-state-error-primary, #e06a6a)' };
      return h('div', { style: page ? Object.assign({}, S.header, { padding: '0' }) : S.header },
        h('div', { style: S.headText },
          h('div', { style: page ? S.pageTitle : S.name }, t('title')),
          h('div', { style: S.description }, t('description'))),
        h('span', { style: S.pill, 'data-status-pill': status },
          h('span', { style: Object.assign({}, S.dot, { background: statusInfo.color }) }),
          h('span', null, t(statusInfo.key))));
    }

    /**
     * The shared settings body: 18 fields (11 toggles, 2 selects, 3 bounded
     * numbers), the demo group and the test/reset footer, with loading /
     * unavailable / read-only degradation.
     * @param {object} model - panel model from {@link usePanelModel}.
     * @returns {Array} body children.
     */
    function buildPanelBodyChildren(model) {
      const t = model.t;
      const status = model.status;
      const ready = model.ready;
      const writable = model.writable;
      const value = model.value;
      const write = model.write;
      const bodyChildren = [];
      if (!ready) {
        bodyChildren.push(h('div', { style: S.note, role: 'status', 'data-note': status },
          t(status === 'loading' ? 'noteLoading' : 'noteUnavailable')));
        return bodyChildren;
      }
      if (!writable) {
        bodyChildren.push(h('div', { style: S.note, role: 'status' }, t('noteReadOnly')));
      }

      // Master switch first: everything else is conditional behaviour.
      bodyChildren.push(h(ToggleRow, {
        key: 'enabled',
        field: 'enabled',
        label: t(labelKeyOf('enabled')),
        hint: t(labelKeyOf('enabled') + 'Hint'),
        value: readBool(value, 'enabled'),
        disabled: !writable,
        onChange: function (next) { write('enabled', next); },
      }));

      bodyChildren.push(h('div', { style: S.section }, t('sectionWhen')));
      bodyChildren.push(h(ToggleRow, {
        key: 'onTurnComplete',
        field: 'onTurnComplete',
        label: t(labelKeyOf('onTurnComplete')),
        hint: t(labelKeyOf('onTurnComplete') + 'Hint'),
        value: readBool(value, 'onTurnComplete'),
        disabled: !writable,
        onChange: function (next) { write('onTurnComplete', next); },
      }));
      bodyChildren.push(h(ToggleRow, {
        key: 'onApproval',
        field: 'onApproval',
        label: t(labelKeyOf('onApproval')),
        hint: t(labelKeyOf('onApproval') + 'Hint'),
        value: readBool(value, 'onApproval'),
        disabled: !writable,
        onChange: function (next) { write('onApproval', next); },
      }));
      bodyChildren.push(h(ToggleRow, {
        key: 'onError',
        field: 'onError',
        label: t(labelKeyOf('onError')),
        hint: t(labelKeyOf('onError') + 'Hint'),
        value: readBool(value, 'onError'),
        disabled: !writable,
        onChange: function (next) { write('onError', next); },
      }));
      bodyChildren.push(h(ToggleRow, {
        key: 'onUserQuestion',
        field: 'onUserQuestion',
        label: t(labelKeyOf('onUserQuestion')),
        hint: t(labelKeyOf('onUserQuestion') + 'Hint'),
        value: readBool(value, 'onUserQuestion'),
        disabled: !writable,
        onChange: function (next) { write('onUserQuestion', next); },
      }));

      bodyChildren.push(h('div', { style: S.section }, t('sectionBehavior')));
      bodyChildren.push(h(ToggleRow, {
        key: 'approvalActions',
        field: 'approvalActions',
        label: t(labelKeyOf('approvalActions')),
        hint: t(labelKeyOf('approvalActions') + 'Hint'),
        value: readBool(value, 'approvalActions'),
        disabled: !writable,
        onChange: function (next) { write('approvalActions', next); },
      }));
      bodyChildren.push(h(ToggleRow, {
        key: 'questionActions',
        field: 'questionActions',
        label: t(labelKeyOf('questionActions')),
        hint: t(labelKeyOf('questionActions') + 'Hint'),
        value: readBool(value, 'questionActions'),
        disabled: !writable,
        onChange: function (next) { write('questionActions', next); },
      }));
      bodyChildren.push(h(NumberRow, {
        key: 'questionTimeoutSec',
        field: 'questionTimeoutSec',
        label: t(labelKeyOf('questionTimeoutSec')),
        hint: t(labelKeyOf('questionTimeoutSec') + 'Hint'),
        value: readNumber(value, 'questionTimeoutSec'),
        unit: t('unitSeconds'),
        disabled: !writable,
        onCommit: function (next) { write('questionTimeoutSec', next); },
      }));
      bodyChildren.push(h(ToggleRow, {
        key: 'skipWhenForeground',
        field: 'skipWhenForeground',
        label: t(labelKeyOf('skipWhenForeground')),
        hint: t(labelKeyOf('skipWhenForeground') + 'Hint'),
        value: readBool(value, 'skipWhenForeground'),
        disabled: !writable,
        onChange: function (next) { write('skipWhenForeground', next); },
      }));

      bodyChildren.push(h('div', { style: S.section }, t('sectionContent')));
      bodyChildren.push(h(ToggleRow, {
        key: 'includePreview',
        field: 'includePreview',
        label: t(labelKeyOf('includePreview')),
        hint: t(labelKeyOf('includePreview') + 'Hint'),
        value: readBool(value, 'includePreview'),
        disabled: !writable,
        onChange: function (next) { write('includePreview', next); },
      }));
      bodyChildren.push(h(ToggleRow, {
        key: 'smartSummary',
        field: 'smartSummary',
        label: t(labelKeyOf('smartSummary')),
        hint: t(labelKeyOf('smartSummary') + 'Hint'),
        value: readBool(value, 'smartSummary'),
        disabled: !writable,
        onChange: function (next) { write('smartSummary', next); },
      }));
      bodyChildren.push(h(ToggleRow, {
        key: 'sessionCollapse',
        field: 'sessionCollapse',
        label: t(labelKeyOf('sessionCollapse')),
        hint: t(labelKeyOf('sessionCollapse') + 'Hint'),
        value: readBool(value, 'sessionCollapse'),
        disabled: !writable,
        onChange: function (next) { write('sessionCollapse', next); },
      }));
      bodyChildren.push(h(NumberRow, {
        key: 'maxPreviewChars',
        field: 'maxPreviewChars',
        label: t(labelKeyOf('maxPreviewChars')),
        hint: t(labelKeyOf('maxPreviewChars') + 'Hint'),
        value: readNumber(value, 'maxPreviewChars'),
        unit: t('unitChars'),
        disabled: !writable,
        onCommit: function (next) { write('maxPreviewChars', next); },
      }));

      bodyChildren.push(h('div', { style: S.section }, t('sectionSound')));
      bodyChildren.push(h(SelectRow, {
        key: 'sound',
        field: 'sound',
        label: t(labelKeyOf('sound')),
        hint: null,
        value: readSound(value),
        options: [
          { value: 'default', label: t('soundDefault') },
          { value: 'silent', label: t('soundSilent') },
        ],
        disabled: !writable,
        onChange: function (next) { write('sound', next); },
      }));
      bodyChildren.push(h(NumberRow, {
        key: 'approvalTimeoutSec',
        field: 'approvalTimeoutSec',
        label: t(labelKeyOf('approvalTimeoutSec')),
        hint: t(labelKeyOf('approvalTimeoutSec') + 'Hint'),
        value: readNumber(value, 'approvalTimeoutSec'),
        unit: t('unitSeconds'),
        disabled: !writable,
        onCommit: function (next) { write('approvalTimeoutSec', next); },
      }));

      // Demo group: pick a notification kind, then fire a sample of it.
      bodyChildren.push(h('div', { style: S.section }, t('sectionDemo')));
      bodyChildren.push(h(SelectRow, {
        key: 'demoKind',
        field: 'demoKind',
        label: t('fieldDemoKind'),
        hint: t('fieldDemoKindHint'),
        value: model.demoSelection,
        options: [
          { value: 'complete', label: t('demoKindComplete') },
          { value: 'approval', label: t('demoKindApproval') },
          { value: 'question-options', label: t('demoKindQuestionOptions') },
          { value: 'question-text', label: t('demoKindQuestionText') },
        ],
        disabled: !writable,
        onChange: function (next) {
          model.setDemoSelection(next);
          write('demoKind', next);
        },
      }));
      bodyChildren.push(h('div', { style: S.demoRow },
        h('button', {
          type: 'button',
          'data-action': 'demo',
          disabled: !writable,
          onClick: function () { if (writable) model.sendDemoPing(); },
          className: 'dsh-wn-btn dsh-wn-btn-ghost',
          style: S.ghostButton,
        }, t('demo')),
        model.demoFeedback
          ? h('span', {
            style: S.sentNote,
            role: 'status',
            'data-demo-feedback': model.demoFeedback,
          }, t(model.demoFeedback === 'unconfirmed' ? 'demoSentUnconfirmed' : 'demoSent'))
          : null));
      bodyChildren.push(h('div', { style: S.footerHint }, t('fieldDemoPingHint')));

      bodyChildren.push(h('div', { style: S.footer },
        h('button', {
          type: 'button',
          'data-action': 'test',
          disabled: !writable,
          onClick: function () { if (writable) model.sendTestPing(); },
          className: 'dsh-wn-btn dsh-wn-btn-primary',
          style: S.primaryButton,
        }, t('test')),
        h('button', {
          type: 'button',
          'data-action': 'reset',
          disabled: !writable,
          title: t('resetHint'),
          onClick: function () { if (writable) model.clearFields(); },
          className: 'dsh-wn-btn dsh-wn-btn-ghost',
          style: S.ghostButton,
        }, t('reset')),
        model.testFeedback
          ? h('span', {
            style: S.sentNote,
            role: 'status',
            'data-test-feedback': model.testFeedback,
          }, t(model.testFeedback === 'unconfirmed' ? 'testSentUnconfirmed' : 'testSent'))
          : null));
      bodyChildren.push(h('div', { style: S.footerHint }, t('fieldTestPingHint')));
      return bodyChildren;
    }

    // ----------------------------------------------------------------- card
    /**
     * Old-runtime shell: the plugin's settings card inside the configurable
     * plugins tab. Root stays `<li class="dsh-wn-card">` for the tab's `<ul>`.
     * @param {object} rawProps - injected face `{ scope, t }`.
     * @returns {object} the card element tree.
     */
    function WindowsNotificationCard(rawProps) {
      const model = usePanelModel(rawProps);
      try {
        const header = buildPanelHeader(model, false);
        const body = h('div', { style: S.body }, buildPanelBodyChildren(model));
        return h('li', {
          style: S.card,
          className: 'dsh-wn-card',
          'data-plugin': PLUGIN_ID,
          'data-namespace': NAMESPACE,
          'data-status': model.status,
          'aria-label': model.t('title'),
        }, header, body);
      } catch (error) {
        logFailure('card render failed', error);
        // Last-resort tree: the slot runtime deactivates a crashing entry, so
        // surface the failure locally instead of taking the card down.
        let reason = '';
        try { reason = String((error && error.message) || error || ''); } catch (ignored) { reason = 'unknown'; }
        return h('li', {
          style: S.card,
          className: 'dsh-wn-card',
          'data-plugin': PLUGIN_ID,
          'data-namespace': NAMESPACE,
          'data-status': 'error',
        },
        h('div', { style: S.body },
          h('div', { style: S.name }, model.t('title')),
          h('div', { style: S.note, role: 'alert' }, model.t('errorPrefix') + reason)));
      }
    }

    // ----------------------------------------------------- desktop page shell
    /**
     * Desktop-runtime shell: a settings page rendered as one tab of
     * Settings → 内置插件. Full-width section layout; same 18-field body.
     * @param {object} rawProps - injected face `{ scope, t }`.
     * @returns {object} the page element tree.
     */
    function WindowsNotificationPage(rawProps) {
      const model = usePanelModel(rawProps);
      try {
        return h('div', {
          className: 'dsh-wn-page',
          style: S.page,
          'data-plugin': PLUGIN_ID,
          'data-plugin-page': NAMESPACE,
          'data-namespace': NAMESPACE,
          'data-status': model.status,
          'aria-label': model.t('title'),
        },
        buildPanelHeader(model, true),
        h('div', { className: 'dsh-wn-card', style: S.card },
          h('div', { style: S.body }, buildPanelBodyChildren(model))));
      } catch (error) {
        logFailure('settings page render failed', error);
        let reason = '';
        try { reason = String((error && error.message) || error || ''); } catch (ignored) { reason = 'unknown'; }
        return h('div', {
          className: 'dsh-wn-page',
          style: S.page,
          'data-plugin': PLUGIN_ID,
          'data-plugin-page': NAMESPACE,
          'data-status': 'error',
        },
        h('div', { style: S.pageTitle }, model.t('title')),
        h('div', { style: S.note, role: 'alert' }, model.t('errorPrefix') + reason));
      }
    }

    // ---------------------------------------------------------- runtime modes
    /**
     * Translator for the desktop page: the locale dictionary registered under
     * LOCALE_NS when the locale service answers, else the inline copy.
     * @param {object} ctx - browser plugin context.
     * @returns {Function} translate function.
     */
    function createBoundTranslator(ctx) {
      let bound;
      try {
        if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') bound = ctx.locale.bind(LOCALE_NS);
      } catch (error) {
        logFailure('locale bind failed', error);
      }
      return function boundTranslate(key, params) {
        if (bound) {
          try {
            const text = bound(key, params);
            if (typeof text === 'string' && text !== key) return text;
          } catch (error) { /* fall back to the inline copy */ }
        }
        return translate(key, params);
      };
    }

    /**
     * Old OSS runtime (0.1.x): keyed card bound to `ctx.settingsScope`.
     * @param {object} ctx - context carrying the settingsScope service.
     */
    function mountLegacyCard(ctx) {
      let scope;
      try {
        if (ctx && ctx.settingsScope && typeof ctx.settingsScope.bind === 'function') {
          scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
        }
      } catch (error) {
        logFailure('settings scope binding failed', error);
        scope = undefined;
      }
      const face = { scope: scope, t: translate };
      const injectCard = function () {
        return ctx.slots.register({
          name: CARD_SLOT,
          key: NAMESPACE,
          inject: function () { return face; },
        }, WindowsNotificationCard);
      };
      try {
        if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
          // Slots are declared by the settings-plugins package; inject() waits
          // for that declaration (and re-registers on a declaration epoch).
          ctx.slots.inject(CARD_SLOT, injectCard);
        } else if (ctx && ctx.slots && typeof ctx.slots.register === 'function') {
          // Degraded deployment: the slot is already declared, so registering
          // directly is still correct.
          injectCard();
        }
      } catch (error) {
        logFailure('settings card registration failed', error);
      }
    }

    /**
     * Desktop runtime (0.2.x): settings page bound to `ctx.configForms`, shown
     * only while the Host serves this plugin's loader entry id.
     * @param {object} ctx - context carrying the configForms service.
     */
    function mountDesktopPage(ctx) {
      const t = createBoundTranslator(ctx);
      try {
        if (ctx && ctx.locale && typeof ctx.locale.register === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return ctx.locale.register(LOCALE_NS, { zh: STRINGS.zh, en: STRINGS.en });
          }, PLUGIN_ID + ': dictionaries');
        }
      } catch (error) {
        logFailure('locale dictionary registration failed', error);
      }
      const configForms = ctx && ctx.configForms;
      const scopeOf = function () {
        try {
          if (configForms && typeof configForms.get === 'function') return configForms.get(ENTRY_ID);
        } catch (error) {
          logFailure('configForms.get failed', error);
        }
        return undefined;
      };
      const registerPage = function () {
        return ctx.slots.register({
          name: PAGE_SLOT,
          id: ENTRY_ID,
          order: 50,
          label: function () { return t('title'); },
          locale: LOCALE_NS,
          inject: function () { return { scope: scopeOf(), t: t }; },
        }, WindowsNotificationPage);
      };
      try {
        if (typeof ctx.effect === 'function' && configForms && typeof configForms.whileServed === 'function') {
          ctx.effect(function () {
            return configForms.whileServed([ENTRY_ID], function () {
              return ctx.slots.inject(PAGE_SLOT, registerPage);
            });
          }, PLUGIN_ID + ': settings page');
        } else if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.slots.inject(PAGE_SLOT, registerPage);
        }
      } catch (error) {
        logFailure('settings page registration failed', error);
      }
    }

    // --------------------------------------------------------------- plugin
    /** Always-present browser plugin services; settings modes are child fibers. */
    const inject = ['slots', 'locale'];

    /**
     * Mount the browser half: keep the language in sync, inject the
     * interactive-state stylesheet, then activate whichever settings mode the
     * runtime provides. Every step is guarded: a deployment missing a service
     * still gets a UI that explains the state rather than a broken entry.
     * @param {object} ctx - browser plugin context.
     */
    function apply(ctx) {
      ensureStyle();

      syncLang(ctx);
      try {
        if (ctx && ctx.locale && typeof ctx.locale.subscribe === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return ctx.locale.subscribe(function () { syncLang(ctx); });
          }, PLUGIN_ID + ': locale');
        }
      } catch (error) {
        logFailure('locale subscription failed', error);
      }

      try {
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () { return function () { removeStyle(); }; }, PLUGIN_ID + ': card styles');
        }
      } catch (error) {
        logFailure('style teardown registration failed', error);
      }

      // Dual-runtime dispatch: each child fiber activates only once its
      // settings service exists (and stays pending on the other runtime).
      try {
        if (ctx && typeof ctx.inject === 'function') {
          ctx.inject(['settingsScope'], function (scopeCtx) {
            try { mountLegacyCard(scopeCtx || ctx); } catch (error) { logFailure('legacy settings card mount failed', error); }
          });
          ctx.inject(['configForms'], function (formsCtx) {
            try { mountDesktopPage(formsCtx || ctx); } catch (error) { logFailure('desktop settings page mount failed', error); }
          });
          return;
        }
      } catch (error) {
        logFailure('runtime settings injection failed', error);
      }

      // Degraded host without ctx.inject: old-runtime path only, if present.
      try {
        if (ctx && ctx.settingsScope && typeof ctx.settingsScope.bind === 'function') mountLegacyCard(ctx);
      } catch (error) {
        logFailure('settings card registration failed', error);
      }
    }

    return {
      inject: inject,
      apply: apply,
    };
  },
});
