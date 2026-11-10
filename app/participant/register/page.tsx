import RegistrationClient from "./registration-client";

export default async function ParticipantRegistrationPage({ searchParams }: { searchParams: Promise<{ slug?: string | string[] }> }) {
  const { slug } = await searchParams;
  return <RegistrationClient slug={typeof slug === "string" ? slug : ""} />;
}
