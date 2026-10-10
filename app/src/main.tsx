import { render } from "solid-js/web";
import { installPress } from "./motion/press";
import { Shell } from "./shell/shell";
import "./styles.css";
import { bootAppearance } from "./ui/settings/appearance";

// before the first frame, so a cold launch paints in the appearance this device chose
bootAppearance();
installPress();

const root = document.getElementById("root");
// index.html ships the root element; its absence is a broken build
if (root) render(() => <Shell />, root);
