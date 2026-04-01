import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        vault: {
          green: "#1db954",
          yellow: "#f5a623",
          red: "#e53e3e",
          blue: "#3182ce",
          gray: "#2d3748",
        },
      },
    },
  },
  plugins: [],
};

export default config;
