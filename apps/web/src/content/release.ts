import { modeAvailable, releaseChannel } from "@rcai/conversation-core";
export const RELEASE_CHANNEL = releaseChannel(import.meta.env.VITE_RCAI_RELEASE_CHANNEL);
export const availableMode = (mode: string) => modeAvailable(mode, RELEASE_CHANNEL);
