// GitHub Pages serves 404.html for unknown paths; copying index.html there lets
// the BrowserRouter handle deep links such as /reading-app/library/<id>.
import { copyFileSync } from "node:fs";
copyFileSync("dist/index.html", "dist/404.html");
