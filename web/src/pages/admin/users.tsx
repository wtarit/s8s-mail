import { adminUserListResponse, type AdminUser } from "#shared";
import {
  IconAt,
  IconDots,
  IconLink,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { LoadError } from "@/components/load-error";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserAvatar } from "@/components/user-avatar";
import { api, apiVoid } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/use-resource";
import { useT } from "@/i18n";
import { AliasesDialog } from "./aliases-dialog";
import { EditUserDialog } from "./edit-user-dialog";
import { InviteDialog } from "./invite-dialog";
import { NewUserDialog } from "./new-user-dialog";

type Action =
  | { kind: "invite"; user: AdminUser }
  | { kind: "edit"; user: AdminUser }
  | { kind: "aliases"; user: AdminUser }
  | { kind: "disable"; user: AdminUser }
  | { kind: "delete"; user: AdminUser };

export function UsersPage() {
  const t = useT();
  const { me } = useMe();
  const { data, loading, error, reload } = useResource(() =>
    api("/api/admin/users", adminUserListResponse),
  );
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const users = data?.users;

  const newButton = (
    <Button onClick={() => setCreating(true)}>
      <IconPlus size={18} stroke={1.75} />
      {t("users.new")}
    </Button>
  );

  async function setDisabled(user: AdminUser, disabled: boolean) {
    await apiVoid(`/api/admin/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: { disabled },
    });
    toast.success(t(disabled ? "users.disabledToast" : "users.enabledToast", { name: user.name }));
    await reload();
  }

  const pick = (kind: Action["kind"], user: AdminUser) => setAction({ kind, user } as Action);

  return (
    <>
      <PageHeader
        title={t("adminUsers.title")}
        description={t("users.description")}
        action={users && users.length > 0 ? newButton : undefined}
      />

      {loading ? <ListSkeleton rows={4} /> : null}
      {error && !data ? <LoadError message={error} onRetry={() => void reload()} /> : null}
      {users && users.length === 0 ? (
        <EmptyState icon={IconUsers} message={t("users.empty")} action={newButton} />
      ) : null}

      {users && users.length > 0 ? (
        <div className="border-border overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("users.colUser")}</TableHead>
                <TableHead>{t("users.colAliases")}</TableHead>
                <TableHead>{t("users.colRole")}</TableHead>
                <TableHead>{t("users.colLastSignIn")}</TableHead>
                <TableHead>{t("users.colStatus")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("users.colActions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => {
                const isSelf = user.id === me.user.id;
                return (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <UserAvatar name={user.name} email={user.email} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{user.name}</p>
                          <p className="text-muted-foreground truncate text-[13px]">{user.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{user.aliasCount}</TableCell>
                    <TableCell>
                      <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                        {t(user.role === "admin" ? "role.admin" : "role.user")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {user.lastSignInAt ? formatDateTime(user.lastSignInAt) : t("users.never")}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={user.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("users.actionsFor", { name: user.name })}
                          >
                            <IconDots size={18} stroke={1.75} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => pick("invite", user)}>
                            <IconLink size={18} stroke={1.75} />
                            {t("users.actionInvite")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => pick("edit", user)}>
                            <IconPencil size={18} stroke={1.75} />
                            {t("users.actionEdit")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => pick("aliases", user)}>
                            <IconAt size={18} stroke={1.75} />
                            {t("users.actionAliases")}
                          </DropdownMenuItem>
                          {!isSelf ? (
                            <>
                              <DropdownMenuSeparator />
                              {user.status === "disabled" ? (
                                <DropdownMenuItem
                                  onSelect={() => {
                                    void setDisabled(user, false).catch(() =>
                                      toast.error(t("error.generic")),
                                    );
                                  }}
                                >
                                  <IconPlayerPlay size={18} stroke={1.75} />
                                  {t("users.actionEnable")}
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem onSelect={() => pick("disable", user)}>
                                  <IconPlayerPause size={18} stroke={1.75} />
                                  {t("users.actionDisable")}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => pick("delete", user)}
                              >
                                <IconTrash size={18} stroke={1.75} />
                                {t("users.actionDelete")}
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <NewUserDialog open={creating} onOpenChange={setCreating} onCreated={reload} />
      <InviteDialog
        user={action?.kind === "invite" ? action.user : null}
        onClose={() => setAction(null)}
      />
      <EditUserDialog
        user={action?.kind === "edit" ? action.user : null}
        isSelf={action?.kind === "edit" && action.user.id === me.user.id}
        onClose={() => setAction(null)}
        onSaved={reload}
      />
      <AliasesDialog
        user={action?.kind === "aliases" ? action.user : null}
        onClose={() => setAction(null)}
        onChanged={reload}
      />

      <ConfirmDialog
        open={action?.kind === "disable"}
        onOpenChange={(open) => !open && setAction(null)}
        title={t("users.disableTitle", { name: action?.user.name ?? "" })}
        description={t("users.disableBody")}
        confirmLabel={t("users.actionDisable")}
        onConfirm={async () => {
          if (action?.kind === "disable") await setDisabled(action.user, true);
        }}
      />
      <ConfirmDialog
        open={action?.kind === "delete"}
        onOpenChange={(open) => !open && setAction(null)}
        title={t("users.deleteTitle", { name: action?.user.name ?? "" })}
        description={t("users.deleteBody", { email: action?.user.email ?? "" })}
        confirmLabel={t("users.actionDelete")}
        onConfirm={async () => {
          if (action?.kind !== "delete") return;
          await apiVoid(`/api/admin/users/${encodeURIComponent(action.user.id)}`, {
            method: "DELETE",
          });
          toast.success(t("users.deletedToast", { name: action.user.name }));
          await reload();
        }}
      />
    </>
  );
}
