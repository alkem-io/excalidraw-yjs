import React from "react";

import DropdownMenuSub from "../../dropdownMenu/DropdownMenuSub";

const EMOJIS = ["👍", "👏", "😂", "❤️", "🎉", "🔥", "😮", "😢", "👀", "💯"];

export const EmojiPickerPanel: React.FC<{
  onSelect: (emoji: string) => void;
  asMenuItems?: boolean;
}> = ({ onSelect, asMenuItems = false }) => (
  <div className="emoji-submenu__grid">
    {EMOJIS.map((emoji) => {
      const button = (
        <button
          key={emoji}
          type="button"
          className="emoji-submenu__emoji"
          onClick={() => {
            onSelect(emoji);
          }}
        >
          {emoji}
        </button>
      );

      return asMenuItems ? (
        <DropdownMenuSub.Item key={emoji} asChild>
          {button}
        </DropdownMenuSub.Item>
      ) : (
        button
      );
    })}
  </div>
);

EmojiPickerPanel.displayName = "EmojiPickerPanel";
