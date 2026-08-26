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

  return (
    <DropdownMenuSub>
      <DropdownMenuSub.Trigger
        icon={countdownTimerIcon}
        data-testid="toolbar-countdown-timer"
      >
        {t("toolBar.countdownTimer")}
      </DropdownMenuSub.Trigger>
      <DropdownMenuSub.Content>
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
                onChange={(e) =>
                  setSeconds(
                    Math.max(0, Math.min(59, Number(e.target.value) || 0)),
                  )
                }
              />
            </label>
          </div>
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
        </div>
      </DropdownMenuSub.Content>
    </DropdownMenuSub>
  );
};

export default CountdownTimerSubmenu;
