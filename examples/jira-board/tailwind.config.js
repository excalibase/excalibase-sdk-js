/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Atlassian / Jira-ish palette.
        brand: {
          50: "#deebff",
          100: "#b3d4ff",
          200: "#4c9aff",
          500: "#0052cc",
          700: "#0747a6",
        },
        // Status column accents.
        status: {
          backlog: "#dfe1e6",
          todo: "#deebff",
          progress: "#fff0b3",
          review: "#eae6ff",
          done: "#abf5d1",
        },
        // Priority pill colors.
        prio: {
          critical: "#cf1124",
          high: "#e87722",
          medium: "#0052cc",
          low: "#6b778c",
        },
      },
      fontFamily: {
        sans: ['"Inter"', "system-ui", "-apple-system", "sans-serif"],
        mono: ["JetBrains Mono", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(9, 30, 66, 0.08), 0 0 1px rgba(9, 30, 66, 0.31)",
        "card-hover": "0 8px 16px rgba(9, 30, 66, 0.15), 0 0 1px rgba(9, 30, 66, 0.31)",
      },
    },
  },
  plugins: [],
};
