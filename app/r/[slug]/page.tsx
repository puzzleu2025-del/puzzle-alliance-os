import RegistrationClient from "./registration-client";

export const dynamic = "force-dynamic";

export default async function RegistrationPage({ params }: { params: Promise<{slug:string}> }) {
  const { slug } = await params;
  return <RegistrationClient slug={slug} />;
}
