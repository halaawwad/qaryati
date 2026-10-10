// Database seed entry point. Seed data is added together with the domain models.

async function main(): Promise<void> {
  console.log('Seed: nothing to seed yet.');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
