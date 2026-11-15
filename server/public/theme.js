// Light or dark for omp Sessions. index.html loads this in <head>, before the page first
// paints, so a device in light mode never flashes the dark colors. The preference is
// "system", "light" or "dark"; "system" follows the device, also when the device switches
// while the page is open. app.js reads and changes it with themePreference() and
// setThemePreference(), and hands it to the chat page in ?theme=.

const THEME_KEY = "omp-sessions:theme";
const THEME_PREFERENCES = ["system", "light", "dark"];
const systemLightQuery = window.matchMedia("(prefers-color-scheme: light)");

function themePreference() {
  const stored = localStorage.getItem(THEME_KEY);
  return THEME_PREFERENCES.includes(stored) ? stored : "system";
}

// app.css colors the page from data-theme, the scheme in effect, and shows the theme
// button's icon for data-theme-preference.
function applyTheme() {
  const preference = themePreference();
  const root = document.documentElement;
  root.dataset.themePreference = preference;
  root.dataset.theme = preference === "system" ? (systemLightQuery.matches ? "light" : "dark") : preference;
}

function setThemePreference(preference) {
  localStorage.setItem(THEME_KEY, preference);
  applyTheme();
}

systemLightQuery.addEventListener("change", applyTheme);
applyTheme();
