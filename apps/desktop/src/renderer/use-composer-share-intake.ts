import { useEffect } from "react";
import { claimSharedIntake, subscribeSharedIntake } from "./share-target-intake";

/** Take a shared payload into THIS composer. Only the focused, visible pane
 *  subscribes, so a share never lands in a conversation the user cannot see. */
export function useComposerShareIntake({ active, attachFiles, appendText }: {
  active: boolean;
  attachFiles: (files: File[]) => void | Promise<void>;
  appendText: (text: string) => void;
}): void {
  useEffect(() => {
    if (!active) return undefined;
    const consume = () => {
      const intake = claimSharedIntake();
      if (!intake) return;
      if (intake.text) appendText(intake.text);
      if (intake.files.length) void attachFiles(intake.files);
    };
    // The payload may already be waiting: the app claims it during boot, well
    // before a composer mounts.
    consume();
    return subscribeSharedIntake(consume);
  }, [active, appendText, attachFiles]);
}
