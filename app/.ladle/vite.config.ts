/* ladle's vite: the thread's components are solid and the stories that host
   them are react (ladle is react-only), so each plugin takes only its own
   files. the solid plugin runs first, so a solid file's jsx is gone before
   the react plugin sees it. */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { marksInHtml } from "../src/ui/composer/marks-sprite";

export default defineConfig({
  plugins: [
    marksInHtml(),
    solid({ include: [/src\/.*\.tsx$/], exclude: [/\.stories\.tsx$/] }),
    react({ include: [/\.stories\.tsx$/, /\.ladle\/.*\.tsx$/] }),
  ],
  server: { host: "127.0.0.1", strictPort: true },
});
