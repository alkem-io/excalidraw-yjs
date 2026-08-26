import { useState } from "react";

import { t } from "../../i18n";

import DropdownMenuSub from "../dropdownMenu/DropdownMenuSub";
import { countdownTimerIcon } from "../icons";

import "./CountdownTimer.scss";

const CountdownTimerSubmenu = ({
  onStart,
}: {
  onStart: (minutes: number, seconds: number) => void;
}) => {
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);

  const handleFormKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (
    event,
  ) => {
    if (event.key !== "Tab") {
      return;
    }

    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "input:not([disabled]), button:not([disabled])",
      ),
    );
    if (!controls.length) {
      return;
    }

    const currentIndex = controls.indexOf(
      document.activeElement as HTMLElement,
    );
    const nextIndex = event.shiftKey
      ? currentIndex <= 0
        ? controls.length - 1
        : currentIndex - 1
      : currentIndex >= controls.length - 1
      ? 0
      : currentIndex + 1;

    event.preventDefault();
    controls[nextIndex].focus();
  };

  const handleNumberKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    update: React.Dispatch<React.SetStateAction<number>>,
    max: number,
  ) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    update((value) =>
      Math.max(0, Math.min(max, value + (event.key === "ArrowUp" ? 1 : -1))),
    );
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSub.Trigger
        icon={countdownTimerIcon}
        data-testid="toolbar-countdown-timer"
      >
        {t("toolBar.countdownTimer")}
      </DropdownMenuSub.Trigger>
      <DropdownMenuSub.Content onKeyDown={handleFormKeyDown}>
        <div className="countdown-timer-submenu">
          <div className="countdown-timer-submenu__title">
            {t("toolBar.countdownTimerSet")}
          </div>
          <div className="countdown-timer-submenu__inputs">
            <label className="countdown-timer-submenu__field">
              <span>{t("toolBar.countdownTimerMinutes")}</span>
              <input
                type="number"
                min={0}
                max={99}
                value={minutes}
                onKeyDown={(event) =>
                  handleNumberKeyDown(event, setMinutes, 99)
                }
                onChange={(e) =>
                  setMinutes(
                    Math.max(0, Math.min(99, Number(e.target.value) || 0)),
                  )
                }
              />
            </label>
            <label className="countdown-timer-submenu__field">
              <span>{t("toolBar.countdownTimerSeconds")}</span>
              <input
                type="number"
                min={0}
                max={59}
                value={seconds}
                onKeyDown={(event) =>
                  handleNumberKeyDown(event, setSeconds, 59)
                }
                onChange={(e) =>
                  setSeconds(
                    Math.max(0, Math.min(59, Number(e.target.value) || 0)),
                  )
                }
              />
            </label>
          </div>
          <DropdownMenuSub.Item asChild>
            <button
              type="button"
              className="countdown-timer-submenu__start"
              onClick={() => {
                if (minutes > 0 || seconds > 0) {
                  onStart(minutes, seconds);
                }
              }}
            >
              {t("toolBar.countdownTimerStart")}
            </button>
          </DropdownMenuSub.Item>
        </div>
      </DropdownMenuSub.Content>
    </DropdownMenuSub>
  );
};

export default CountdownTimerSubmenu;
