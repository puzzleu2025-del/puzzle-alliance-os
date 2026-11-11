import ConsentClient from "./consent-client";

export const dynamic = "force-dynamic";

export default async function ParticipantConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const slug = Object.keys(params).length === 1 && typeof params.slug === "string" && /^[a-f0-9]{32}$/.test(params.slug) ? params.slug : null;
  return <ConsentClient returnSlug={slug} />;
}
