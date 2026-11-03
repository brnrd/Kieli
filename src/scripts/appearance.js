(() => {
  const key = "kieli:appearance";
  const modes = ["auto", "light", "dark"];
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const read = () => {
    try {
      const stored = localStorage.getItem(key);
      return modes.includes(stored) ? stored : "auto";
    } catch {
      return "auto";
    }
  };
  let mode = read();
  const apply = () => {
    const theme = mode === "auto" ? (system.matches ? "dark" : "light") : mode;
    document.documentElement.dataset.appearance = mode;
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#141c17" : "#fafbf9");
    window.dispatchEvent(
      new CustomEvent("kieli:appearance-change", { detail: mode }),
    );
  };
  window.addEventListener("kieli:appearance-select", (event) => {
    if (!modes.includes(event.detail)) return;
    mode = event.detail;
    try {
      localStorage.setItem(key, mode);
    } catch {
      /* Keep this page usable when storage is blocked. */
    }
    apply();
  });
  system.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      mode = read();
      apply();
    }
  });
  apply();
})();
