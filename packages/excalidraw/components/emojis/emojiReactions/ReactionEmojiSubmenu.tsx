import { t } from "../../../i18n";

import DropdownMenuSub from "../../dropdownMenu/DropdownMenuSub";
import { reactionToolIcon } from "../../icons";

import "../insertEmoji/EmojiPicker.scss";

import { EmojiPickerPanel } from "./EmojiPickerPanel";

const ReactionEmojiSubmenu = ({
  onSelect,
}: {
  onSelect: (emoji: string) => void;
}) => {
  return (
    <DropdownMenuSub>
      <DropdownMenuSub.Trigger
        icon={reactionToolIcon}
        data-testid="toolbar-reactions"
      >
        {t("toolBar.emojiReactions")}
      </DropdownMenuSub.Trigger>
      <DropdownMenuSub.Content className="emoji-submenu__content">
        <EmojiPickerPanel onSelect={onSelect} asMenuItems />
      </DropdownMenuSub.Content>
    </DropdownMenuSub>
  );
};

export default ReactionEmojiSubmenu;
