import { Avatar, AvatarFallback } from "@/components/ui/avatar";

function initials(name: string, email?: string): string {
  const source = name.trim() || email || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase();
}

export function UserAvatar({
  name,
  email,
  size,
}: {
  name: string;
  email?: string;
  size?: "default" | "sm" | "lg";
}) {
  return (
    <Avatar size={size}>
      <AvatarFallback aria-hidden="true">{initials(name, email)}</AvatarFallback>
    </Avatar>
  );
}
