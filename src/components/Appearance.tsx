import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type AppearanceMode = "auto" | "light" | "dark";
const choices = [
  {
    value: "auto",
    label: "Auto",
    icon: Monitor,
    title: "Follow system appearance",
  },
  { value: "light", label: "Light", icon: Sun, title: "Use light appearance" },
  { value: "dark", label: "Dark", icon: Moon, title: "Use dark appearance" },
] as const;

export default function Appearance() {
  const [mode, setMode] = useState<AppearanceMode>("auto");
  useEffect(() => {
    const sync = () => {
      const value = document.documentElement.dataset.appearance;
      setMode(value === "light" || value === "dark" ? value : "auto");
    };
    sync();
    window.addEventListener("keylo:appearance-change", sync);
    return () => window.removeEventListener("keylo:appearance-change", sync);
  }, []);
  return (
    <div className="appearance-picker" role="group" aria-label="Appearance">
      {choices.map(({ value, label, icon: Icon, title }) => (
        <button
          key={value}
          type="button"
          data-appearance-value={value}
          aria-label={`${label} theme`}
          aria-pressed={mode === value}
          title={title}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("keylo:appearance-select", { detail: value }),
            )
          }
        >
          <Icon size={13} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}
