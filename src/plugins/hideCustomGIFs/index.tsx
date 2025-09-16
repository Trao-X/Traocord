/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { DeleteIcon, ImageInvisible, ImageVisible } from "@components/Icons";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Button, Forms, React, TextInput } from "@webpack/common";

type UrlString = string;

const blockedMessageIds = new Set<string>();
const temporarilyUnblockedMessageIds = new Set<string>();
const logger = new Logger("HideCustomGIFs");

function isGifUrl(url?: string | null) {
    if (!url) return false;
    try {
        const u = new URL(url);
        if (u.pathname.toLowerCase().endsWith(".gif")) return true;
        if (u.searchParams.get("animated") === "true") return true;
    } catch { }
    return /\.gif(?:\?|$)/i.test(url);
}

function equalsAnyUrl(url: string, urls: UrlString[]) {
    const normalize = (u: string) => {
        try {
            const parsed = new URL(u);
            // Remove common tracking params
            [
                "utm_source", "utm_medium", "utm_campaign",
                "utm_content", "utm_term"
            ].forEach(k => parsed.searchParams.delete(k));
            parsed.hash = "";
            // Normalize trailing slash
            if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
                parsed.pathname = parsed.pathname.slice(0, -1);
            }
            // Lowercase host only
            parsed.host = parsed.host.toLowerCase();
            return parsed.toString();
        } catch {
            try { return decodeURI(u).replace(/\/?$/, ""); } catch { return u; }
        }
    };

    const target = normalize(url);
    const candidates = urls.map(u => u.trim()).filter(Boolean).map(normalize);
    return candidates.includes(target);
}

const settings = definePluginSettings({
    patterns: {
        type: OptionType.CUSTOM,
        default: [] as UrlString[]
    },
    editPatterns: {
        type: OptionType.COMPONENT,
        description: "Add exact GIF URLs to block. One per row.",
        component: () => {
            const { patterns } = settings.use(["patterns"]);
            function setAt(i: number, val: string) {
                const copy = [...patterns];
                copy[i] = val;
                settings.store.patterns = copy;
            }
            function add() {
                settings.store.patterns = [...patterns, ""];
            }
            function remove(i: number) {
                const copy = [...patterns];
                copy.splice(i, 1);
                settings.store.patterns = copy;
            }
            return (
                <Forms.FormSection>
                    <Forms.FormTitle tag="h3">Blocked GIF URLs</Forms.FormTitle>
                    <Forms.FormText>Paste exact GIF links to block. Matching is exact.</Forms.FormText>
                    <Flex flexDirection="column" style={{ gap: 8 }}>
                        {patterns.map((val, i) => (
                            <Flex key={i} style={{ gap: 8, alignItems: "center" }}>
                                <TextInput
                                    value={val}
                                    placeholder={i === 0 ? "e.g. https://media.tenor.com/.../gif" : "GIF URL"}
                                    onChange={v => setAt(i, v)}
                                    spellCheck={false}
                                    style={{ width: 520 }}
                                />
                                <Button size={Button.Sizes.ICON} onClick={() => remove(i)}>
                                    <DeleteIcon width={20} height={20} />
                                </Button>
                            </Flex>
                        ))}
                        <Button onClick={add} style={{ width: 520 }}>Add Pattern</Button>
                    </Flex>
                </Forms.FormSection>
            );
        }
    },
    replacementMode: {
        type: OptionType.SELECT,
        description: "What to show when a GIF is blocked",
        options: [
            { label: "Show italic 'GIF Blocked' note", value: "note", default: true },
            { label: "Hide completely", value: "hide" }
        ]
    }
});

export default definePlugin({
    name: "HideCustomGIFs",
    description: "Block specific GIFs by exact URL. Optionally show an italic 'GIF Blocked' note.",
    authors: [Devs.TraoX],

    settings,
    dependencies: ["MessageUpdaterAPI"],

    patches: [
        {
            find: "}renderEmbeds(",
            replacement: [
                {
                    match: /(renderEmbeds\((\i)\){)(.+?embeds\.map\(\((\i),\i\)?=>\{)/,
                    replace: (_, start, messageVar, mid, embedVar) => `${start}const hcgiMsg=${messageVar};${mid}if($self._shouldBlockEmbed(${embedVar},hcgiMsg))return null;`
                }
            ]
        },
        {
            find: "renderAttachments",
            replacement: [
                {
                    match: /renderAttachments\(\i\)\{.+?\{attachments:(\i).+?;/,
                    replace: (m: string, attachmentsVar: string) => `${m}${attachmentsVar}=$self._filterAttachments(${attachmentsVar});`
                }
            ]
        }
    ],

    renderMessageAccessory({ message }) {
        if (!blockedMessageIds.has(message.id)) return null;
        if (settings.store.replacementMode !== "note") return null;
        return (
            <span style={{ fontStyle: "italic", color: "var(--text-muted)" }}>
                GIF Blocked
            </span>
        );
    },

    _markBlocked(messageId?: string) {
        if (messageId) blockedMessageIds.add(messageId);
    },

    _shouldBlockUrl(url?: string | null) {
        if (!url) return false;
        if (!isGifUrl(url)) return false;
        try {
            return equalsAnyUrl(url, settings.store.patterns);
        } catch (e) {
            logger.error("Error in _shouldBlockUrl", e);
            return false;
        }
    },

    _shouldBlockEmbed(embed: any, message: any) {
        try {
            if (temporarilyUnblockedMessageIds.has(message?.id)) return false;
            const url: string | undefined = embed?.url || embed?.image?.url || embed?.thumbnail?.url;
            const type: string | undefined = embed?.type;
            const isGifLike = type === "gifv" || isGifUrl(url);
            if (!isGifLike) return false;
            const shouldBlock = type === "gifv"
                ? (url ? equalsAnyUrl(url, settings.store.patterns) : false)
                : this._shouldBlockUrl(url);
            if (shouldBlock) this._markBlocked(message?.id);
            return shouldBlock;
        } catch (e) {
            logger.error("Error in _shouldBlockEmbed", e);
            return false;
        }
    },

    _filterAttachments(arr: any[]) {
        try {
            if (!Array.isArray(arr)) return arr;
            const out = arr.filter(att => {
                if (att?.message_id && temporarilyUnblockedMessageIds.has(att.message_id)) return true;
                const url: string | undefined = att?.url || att?.proxy_url;
                const type: string | undefined = att?.content_type;
                const isGif = (type?.toLowerCase() === "image/gif") || isGifUrl(url);
                if (!isGif) return true;
                const shouldBlock = this._shouldBlockUrl(url);
                if (shouldBlock) this._markBlocked(att?.message_id);
                return !shouldBlock;
            });
            return out;
        } catch (e) {
            logger.error("Error in _filterAttachments", e);
            return arr;
        }
    },

    renderMessagePopoverButton(message: any) {
        const urls = this._collectGifUrlsFromMessage(message);
        if (urls.length === 0) return null;

        const isTemporarilyUnblocked = temporarilyUnblockedMessageIds.has(message.id);
        const isBlockedByList = urls.some(u => equalsAnyUrl(u, settings.store.patterns));

        if (isBlockedByList && !isTemporarilyUnblocked) {
            return {
                label: "Show GIF",
                icon: ImageVisible,
                message,
                channel: (window as any).Vencord.Webpack.Common.ChannelStore.getChannel?.(message.channel_id),
                onClick: () => this._toggleTemporaryUnblock(message, true)
            };
        }

        if (isBlockedByList && isTemporarilyUnblocked) {
            return {
                label: "Hide GIF",
                icon: ImageInvisible,
                message,
                channel: (window as any).Vencord.Webpack.Common.ChannelStore.getChannel?.(message.channel_id),
                onClick: () => this._toggleTemporaryUnblock(message, false)
            };
        }

        return {
            label: "Hide GIFs",
            icon: ImageInvisible,
            message,
            channel: (window as any).Vencord.Webpack.Common.ChannelStore.getChannel?.(message.channel_id),
            onClick: () => this._addUrlsToBlocklistAndRefresh(message, urls)
        };
    },

    _collectGifUrlsFromMessage(message: any): string[] {
        const found = new Set<string>();

        try {
            for (const att of message.attachments ?? []) {
                const url: string | undefined = att?.url || att?.proxy_url;
                const type: string | undefined = att?.content_type;
                const isGif = (type?.toLowerCase() === "image/gif") || isGifUrl(url);
                if (isGif && url) found.add(url);
            }
        } catch { }

        try {
            for (const emb of message.embeds ?? []) {
                const type: string | undefined = emb?.type;
                if (type === "gifv") {
                    if (emb?.url) found.add(emb.url);
                    continue;
                }
                const url: string | undefined = emb?.url || emb?.image?.url || emb?.thumbnail?.url;
                if (isGifUrl(url) && url) found.add(url);
            }
        } catch { }

        return Array.from(found);
    },

    _addUrlsToBlocklistAndRefresh(message: any, urls: string[]) {
        const current = settings.store.patterns ?? [];
        const merged = [...current];
        for (const u of urls) {
            if (!equalsAnyUrl(u, merged)) merged.push(u);
        }
        settings.store.patterns = merged;
        try { updateMessage(message.channel_id, message.id); } catch { }
    },

    _toggleTemporaryUnblock(message: any, shouldUnblock: boolean) {
        if (shouldUnblock) temporarilyUnblockedMessageIds.add(message.id);
        else temporarilyUnblockedMessageIds.delete(message.id);
        try { updateMessage(message.channel_id, message.id); } catch { }
    }
});


