import React from "react";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { chevronRight } from "../icons";

import { getDropdownMenuItemClassName } from "./common";
import MenuItemContent from "./DropdownMenuItemContent";

import type { JSX } from "react";

const DropdownMenuSubTrigger = ({
  children,
  icon,
  shortcut,
  className,
  "data-testid": testId,
}: {
  children: React.ReactNode;
  icon?: JSX.Element;
  shortcut?: string;
  className?: string;
  "data-testid"?: string;
}) => {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={`${getDropdownMenuItemClassName(
        className,
      )} dropdown-menu__submenu-trigger`}
      data-testid={testId}
    >
      <MenuItemContent icon={icon} shortcut={shortcut}>
        {children}
      </MenuItemContent>
      <div className="dropdown-menu__submenu-trigger-icon">{chevronRight}</div>
    </DropdownMenuPrimitive.SubTrigger>
  );
};

export default DropdownMenuSubTrigger;
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";
