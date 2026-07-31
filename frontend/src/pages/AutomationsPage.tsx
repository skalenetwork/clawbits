import {Clock05Icon as Automation} from "@hugeicons/core-free-icons";
import {PageHeader} from "@/components/PageHeader";
import {AutomationsManager} from "@/components/automations/AutomationsManager";
import {useAuth} from "@/context/AuthContext";

/**
 * Org-wide automations roll-up: every automation across the agents the caller
 * operates. Per-agent management also lives on each agent's profile
 * (Automations tab) — both render the same {@link AutomationsManager}. The
 * manager renders the header so its New-automation action docks at the header
 * bar's right end.
 */
export default function AutomationsPage() {
    const {activeOrgId} = useAuth();
    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }
    return (
        <div className="space-y-6 pb-16">
            <AutomationsManager
                orgId={activeOrgId}
                renderPageHeader={(actions) => (
                    <PageHeader icon={Automation} title="Automations" actions={actions}/>
                )}
            />
        </div>
    );
}
