/** Build-time exclusion for optional adapters in the OSS-first distribution. */
class DisabledAvatar {
  constructor() { throw new Error("BLOCKED_BY_OSS_RENDERER: this optional adapter is excluded from the OSS build"); }
}
export { DisabledAvatar as AnamAvatarProvider, DisabledAvatar as Live2DAvatarProvider, DisabledAvatar as LiveAvatarProvider, DisabledAvatar as TavusAvatarProvider };
