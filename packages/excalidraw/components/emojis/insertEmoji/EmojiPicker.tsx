import { convertToExcalidrawElements } from "@excalidraw-yjs/element";

import { t } from "../../../i18n";

import { useApp } from "../../App";
import DropdownMenuSub from "../../dropdownMenu/DropdownMenuSub";
import { EmojiIcon } from "../../icons";

import { defaultInsertEmojiConfig } from "./insertEmojiConfig";

import "./EmojiPicker.scss";

const EMOJI_FONT_SIZE = 48;

const EmojiPicker = ({ onInsert }: { onInsert: () => void }) => {
  const app = useApp();

  const handleInsertEmoji = (emoji: string) => {
    const elements = convertToExcalidrawElements([
      { type: "text", text: emoji, x: 0, y: 0, fontSize: EMOJI_FONT_SIZE },
    ]);
    app.onInsertElements(elements);
    onInsert();
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSub.Trigger icon={EmojiIcon} data-testid="toolbar-emoji">
        {t("toolBar.insertEmoji")}
      </DropdownMenuSub.Trigger>
      <DropdownMenuSub.Content className="emoji-submenu__content">
        <div className="emoji-submenu__grid">
          {defaultInsertEmojiConfig.emojis.map((entry) => (
            <DropdownMenuSub.Item key={entry.emoji} asChild>
              <button
                className="emoji-submenu__emoji"
                onClick={() => handleInsertEmoji(entry.emoji)}
                title={entry.label}
                aria-label={entry.label}
                type="button"
              >
                {entry.emoji}
              </button>
            </DropdownMenuSub.Item>
          ))}
        </div>
      </DropdownMenuSub.Content>
    </DropdownMenuSub>
  );
};

export default EmojiPicker;
