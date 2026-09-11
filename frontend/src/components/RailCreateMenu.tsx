import {useNavigate} from "react-router-dom";
import {Icon} from "@/components/Icon";
import {DropdownMenuItem} from "@/components/ui/dropdown-menu";
import {CREATE_OPTIONS, openCreate} from "@/components/command/createStore";

/** The create rows, each a tinted glyph tile and a title sized like a sidebar
 *  row. Focus keeps every color in place; only a faint wash appears. */
export function CreateMenuItems() {
    const navigate = useNavigate();
    return CREATE_OPTIONS.map((option) => (
        <DropdownMenuItem
            key={option.title}
            onClick={() => {
                if ("to" in option) void navigate(option.to);
                else openCreate(option.kind);
            }}
            className="h-[34px] cursor-pointer gap-2.5 px-2.5 py-0 text-[13px] focus:bg-foreground/5 focus:text-foreground not-data-[variant=destructive]:focus:**:text-inherit"
        >
            <span className={`flex size-5 shrink-0 items-center justify-center rounded-sm ${option.tint}`}>
                <Icon icon={option.icon} className="size-3.5" style={{color: option.color}}/>
            </span>
            {option.title}
        </DropdownMenuItem>
    ));
}
