(() => {
  'use strict';
  const { language, messages } = window.stm32Locale;
  window.stm32I18n = Object.freeze({
    language,
    t(message, ...args) {
      const translated = Object.prototype.hasOwnProperty.call(messages, message) ? messages[message] : message;
      return translated.replace(/\{(\d+)\}/g, (token, index) => Number(index) < args.length ? String(args[Number(index)]) : token);
    }
  });
})();
