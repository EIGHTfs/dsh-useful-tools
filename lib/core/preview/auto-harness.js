/**
 * 预览页通用自动挂载垫片（无 spec 时的默认 harness）
 *
 * 目标：插件没写 `assets/preview.spec.mjs` 也能看到界面，而不是只有空壳。
 *
 * 做法（全部在浏览器里跑，不依赖宿主）：
 *   1) mock `window.__ModuleLoader__` —— DSH 客户端插件的模块加载入口，
 *      `load({ id, factory })` 的 factory 会返回模块 exports（含 apply / inject）。
 *   2) mock `require` —— react / react-dom / jsx-runtime 走页面已内联的 UMD，其余宿主包返回空代理。
 *   3) mock `ctx` —— effect / inject / get / locale / slots 的最小实现；
 *      `slots.register(def, component)` 时把组件**捕获**下来（注意是两个参数）。
 *   4) 对每个含 apply 的模块调用 apply(ctx)，然后挑一个组件 createRoot().render()。
 *
 * 定位（必须说清）：这是**尽力而为**的自动挂载——组件若依赖宿主的 hooks/context
 *   （useSettings、useSession 等）会渲染失败，此时页面显示错误与已捕获的插槽清单，
 *   而不是白屏。要 100% 还原界面仍然需要插件自己写 spec 提供 mock。
 */

/** 组件挑选优先级：设置页 > 插件配置卡 > 侧边栏/其他。 */
const SLOT_PRIORITY = ['settings.section', 'settings.plugin.item', 'settings.plugins', 'sidebar'];

export const AUTO_HARNESS = `
(function () {
  var captured = [];
  window.__PREVIEW_CAPTURED__ = captured;
  var dicts = {};
  var React = window.React;
  var ReactDOM = window.ReactDOM;
  var errors = [];
  window.__PREVIEW_ERRORS__ = errors;

  function show(msg) {
    var root = document.getElementById('root');
    if (!root) return;
    var box = document.createElement('pre');
    box.style.cssText = 'white-space:pre-wrap;color:#f88;background:#1a1d26;padding:12px;border-radius:6px;margin:8px 0';
    box.textContent = String(msg);
    root.appendChild(box);
  }
  window.__previewError = function (e) {
    errors.push(String(e && e.message || e));
    show('[预览错误] ' + (e && e.stack || e));
  };

  // jsx-runtime：client 打包产物常用 jsx/jsxs，用 createElement 等价实现
  function makeJsx(type, props, key) {
    var p = Object.assign({}, props || {});
    if (key != null) p.key = key;
    return React.createElement(type, p);
  }
  var jsxRuntime = { jsx: makeJsx, jsxs: makeJsx, jsxDEV: makeJsx, Fragment: React.Fragment };

  // 宿主包 mock：返回一个「调用即返回 null」的代理，避免 require 报错
  function emptyModule() {
    return new Proxy({}, { get: function () { return function () { return null; }; } });
  }
  function require(name) {
    if (name === 'react') return React;
    if (name === 'react-dom') return ReactDOM;
    if (name === 'react-dom/client') return ReactDOM;
    if (name === 'react/jsx-runtime' || name === 'react/jsx-dev-runtime') return jsxRuntime;
    return emptyModule();
  }

  // slots mock：register 的第二个参数才是组件（def 只带 name/id/order/label）
  var slots = {
    inject: function (_name, cb) { try { cb(); } catch (e) { errors.push('slots.inject: ' + (e && e.message || e)); } return { then: function () {} }; },
    register: function (def, component) { captured.push({ def: def || {}, component: component }); return function () {}; },
    get: function () { return undefined; },
    list: function () { return []; },
    on: function () {},
    emit: function () {}
  };

  var ctx = {
    effect: function (fn) { try { var d = fn(); return typeof d === 'function' ? d : function () {}; } catch (e) { errors.push('effect: ' + (e && e.message || e)); } return function () {}; },
    get: function (name) {
      if (name === 'slots') return slots;
      if (name === 'locale') return ctx.locale;
      if (name === 'sessions') return { open: function () {} };
      return undefined;
    },
    inject: function (_deps, cb) { try { cb(ctx); } catch (e) { errors.push('inject: ' + (e && e.message || e)); } return { then: function () {} }; },
    locale: {
      register: function (ns, d) { dicts[ns] = d || {}; },
      // bind(ns) 返回翻译函数：先从该 ns 的 zh 表取，取不到再扫其它 ns 块，最后回退 key
      bind: function (ns) {
        return function (k) {
          var d = dicts[ns] || {};
          var zh = d.zh || {};
          var table = zh[ns] || {};
          if (Object.prototype.hasOwnProperty.call(table, k)) return table[k];
          for (var n in zh) { if (zh[n] && typeof zh[n][k] === 'string') return zh[n][k]; }
          return String(k);
        };
      },
      get: function (k) { return String(k); },
      t: function (k) { return String(k); }
    },
    slots: slots,
    on: function () {},
    emit: function () {},
    once: function () {}
  };
  window.__PREVIEW_CTX__ = ctx;

  // 模块加载器：factory(require) 返回模块 exports
  var apis = [];
  window.__ModuleLoader__ = {
    load: function (entry) {
      try {
        var api = entry.factory(require);
        if (api && typeof api.apply === 'function') apis.push(api);
      } catch (e) {
        errors.push('ModuleLoader.load(' + (entry && entry.id) + '): ' + (e && e.message || e));
      }
    }
  };

  function pickComponent() {
    var rank = function (item) {
      var n = String((item.def && item.def.name) || '');
      for (var i = 0; i < ${JSON.stringify(SLOT_PRIORITY)}.length; i++) {
        if (n.indexOf(${JSON.stringify(SLOT_PRIORITY)}[i]) === 0) return i;
      }
      return 99;
    };
    var usable = captured.filter(function (x) { return typeof x.component === 'function'; });
    usable.sort(function (a, b) { return rank(a) - rank(b); });
    return usable[0];
  }

  window.__previewMount = function () {
    var root = document.getElementById('root');
    if (!root) { show('[预览] 页面缺少 #root 容器'); return; }
    if (errors.length) show('[加载期错误]\\n' + errors.join('\\n'));
    var hit = pickComponent();
    if (!hit) {
      show('[预览] 没有捕获到可渲染的插槽组件。\\n已捕获插槽：' + (captured.map(function (x) { return (x.def && x.def.name) || '?'; }).join(', ') || '（无）') + '\\n该插件可能不注册 UI 插槽，或组件注册方式不在自动挂载覆盖范围内。');
      return;
    }
    var props = {};
    try {
      if (typeof hit.def.inject === 'function') props = hit.def.inject() || {};
      else if (hit.def.inject && typeof hit.def.inject === 'object') props = hit.def.inject;
    } catch (e) { errors.push('def.inject: ' + (e && e.message || e)); }
    var label = String((hit.def && hit.def.name) || '组件');
    var bar = document.createElement('div');
    bar.style.cssText = 'color:#8ab4f8;font-size:12px;margin-bottom:10px';
    bar.textContent = '[自动挂载] 插槽 ' + label + (hit.def.id ? ' · ' + hit.def.id : '') + '（无 spec 兜底，依赖宿主 hooks 的组件可能渲染失败）';
    root.appendChild(bar);
    try {
      ReactDOM.createRoot(root).render(React.createElement(hit.component, props));
    } catch (e) {
      window.__previewError(e);
    }
  };

  // client.js 的 <script> 在本垫片之后执行，故延后一轮再 apply + mount
  setTimeout(function () {
    for (var i = 0; i < apis.length; i++) {
      try { apis[i].apply(ctx); } catch (e) { errors.push('apply: ' + (e && e.message || e)); }
    }
    try { window.__previewMount(); } catch (e) { window.__previewError(e); }
  }, 0);
})();
`;
