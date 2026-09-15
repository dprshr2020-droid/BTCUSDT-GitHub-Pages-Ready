/* Clean chart persistence.
 * No automatic drawings are created by this project.
 * TradingView's native/manual chart objects and chart state are persisted locally.
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "btcusdt_clean_chart_state_v1";
  var SAVE_INTERVAL = 3000;
  var timer = null;
  var widget = null;
  var restoring = false;

  function save() {
    if (!widget || restoring || !global.localStorage) return;
    try {
      widget.save(function (state) {
        try {
          global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (_) {}
      });
    } catch (_) {}
  }

  function restore() {
    if (!widget || !global.localStorage) return;
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var state = JSON.parse(raw);
      if (!state || typeof state !== "object") return;
      restoring = true;
      widget.load(state);
      setTimeout(function () { restoring = false; save(); }, 500);
    } catch (_) {
      restoring = false;
    }
  }

  function init(w) {
    widget = w;
    restore();
    clearInterval(timer);
    timer = setInterval(save, SAVE_INTERVAL);
    global.addEventListener("beforeunload", save);
  }

  function destroy() {
    clearInterval(timer);
    timer = null;
    global.removeEventListener("beforeunload", save);
    save();
    widget = null;
  }

  global.CleanChartPersistence = { init: init, save: save, destroy: destroy };
})(window);
