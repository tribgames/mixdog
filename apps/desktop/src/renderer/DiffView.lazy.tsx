import { type ComponentProps, useEffect, useState } from "react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";

type DiffData = ComponentProps<typeof DiffView>["data"];

export default function LazyDiffView({ data, mode }: { data: DiffData; mode?: "unified" | "split" }) {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => getComputedStyle(document.documentElement).colorScheme === "light" ? "light" : "dark",
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(getComputedStyle(root).colorScheme === "light" ? "light" : "dark");
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["style", "data-mixdog-theme"] });
    return () => observer.disconnect();
  }, []);
  return <DiffView
    data={data}
    diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
    diffViewTheme={theme}
    diffViewWrap
    diffViewFontSize={12}
  />;
}
