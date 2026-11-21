import type { EuiThemeModifications } from "@elastic/eui";

export const consoleTheme: EuiThemeModifications = {
  colors: {
    LIGHT: {
      primary: "#8b4c28",
      primaryText: "#8b4c28",
      textPrimary: "#8b4c28",
      link: "#8b4c28",
      textSubdued: "#655a50",
      backgroundFilledPrimary: "#8b4c28",
      backgroundBaseInteractiveSelect: "#f5e9dd",
    },
    DARK: {
      primary: "#e7ae80",
      primaryText: "#e7ae80",
      textPrimary: "#e7ae80",
      link: "#e7ae80",
      textSubdued: "#c2b4a7",
      backgroundFilledPrimary: "#e7ae80",
      backgroundBaseInteractiveSelect: "#322720",
    },
  },
  components: {
    forms: {
      LIGHT: { background: "#fff", border: "#a49a92", borderHovered: "#82746b", borderFocused: "#8b4c28" },
      DARK: { background: "#282522", border: "#84746a", borderHovered: "#aa998a", borderFocused: "#e7ae80" },
    },
  },
};
