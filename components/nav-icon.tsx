import {
  IconBell,
  IconBriefcase,
  IconChart,
  IconDashboard,
  IconInbox,
  IconList,
  IconLock,
  IconPlus,
  IconRepeat,
  IconSettings,
  IconShield,
  IconTag,
  IconTarget,
  IconUpload,
  IconUsers,
  IconWallet,
} from "@/components/icons";

/** Maps a NavItem's icon name to its component. */
const MAP = {
  dashboard: IconDashboard,
  plus: IconPlus,
  list: IconList,
  inbox: IconInbox,
  briefcase: IconBriefcase,
  chart: IconChart,
  target: IconTarget,
  repeat: IconRepeat,
  tag: IconTag,
  upload: IconUpload,
  lock: IconLock,
  shield: IconShield,
  users: IconUsers,
  settings: IconSettings,
  bell: IconBell,
  wallet: IconWallet,
} as const;

export function NavIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const Component = MAP[name as keyof typeof MAP] ?? IconList;
  return <Component className={className} />;
}
