import {
    Cancel01Icon as Cross,
    PlusSignIcon as Plus,
    ViewIcon as Eye,
    ViewOffSlashIcon as EyeOff,
} from "@hugeicons/core-free-icons";
import {useState} from "react";
import {Input} from "@/components/ui/input";
import {Icon} from "@/components/Icon";
import {cn} from "@/lib/utils";
import {ENV_KEY_RE, looksSecret} from "./envKeys";

export function EnvVarRow({
    row,
    disabled,
    onChange,
    onRemove,
    lockKey = false,
    secret = false,
    valuePlaceholder = "value",
    removeLabel = "Remove variable",
}: {
    row: {key: string; value: string};
    disabled: boolean;
    onChange: (next: {key: string; value: string}) => void;
    onRemove: () => void;
    lockKey?: boolean;
    secret?: boolean;
    valuePlaceholder?: string;
    removeLabel?: string;
}) {
    const [revealed, setRevealed] = useState(false);
    const k = row.key.trim();
    const invalid = k.length > 0 && !ENV_KEY_RE.test(k);
    const isSecret = secret && looksSecret(row.key);
    const masked = isSecret && !revealed;
    return (
        <div className="flex items-center gap-2">
            <Input
                value={row.key}
                onChange={(e) => { onChange({...row, key: e.target.value}); }}
                placeholder="NAME"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                readOnly={lockKey}
                aria-invalid={invalid}
                className={cn(
                    "flex-1 font-mono text-[13px]",
                    invalid && "border-destructive/60",
                    lockKey && "text-muted-foreground",
                )}
            />
            <div className="relative min-w-0 flex-[1.4]">
                <Input
                    type={masked ? "password" : "text"}
                    value={row.value}
                    onChange={(e) => { onChange({...row, value: e.target.value}); }}
                    placeholder={valuePlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                    // autoComplete="off" is widely ignored; these are the
                    // opt-outs password managers actually honour.
                    {...(isSecret
                        ? {"data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": ""}
                        : {})}
                    className={cn("w-full font-mono text-[13px]", isSecret && "pr-9")}
                />
                {isSecret && (
                    <button
                        type="button"
                        onClick={() => { setRevealed(!revealed); }}
                        disabled={disabled}
                        aria-label={masked ? "Show value" : "Hide value"}
                        className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                    >
                        <Icon icon={masked ? Eye : EyeOff} className="size-4"/>
                    </button>
                )}
            </div>
            <button
                type="button"
                onClick={onRemove}
                disabled={disabled}
                aria-label={removeLabel}
                className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
                <Icon icon={Cross} className="size-4"/>
            </button>
        </div>
    );
}

export function AddEnvRowButton({disabled, onClick}: {disabled: boolean; onClick: () => void}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className="flex items-center gap-1.5 self-start py-0.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
            <Icon icon={Plus} className="size-3.5"/>
            Add variable
        </button>
    );
}
