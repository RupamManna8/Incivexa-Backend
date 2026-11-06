import mongoose from 'mongoose';
import { Investigation } from '../models/Investigation.js';

async function resetFixes() {
  await mongoose.connect('mongodb://localhost:27017/incident_manager');
  const invRes = await Investigation.deleteMany({});
  console.log(`Deleted ${invRes.deletedCount} investigations.`);

  const incRes = await mongoose.connection.db.collection('incidents').updateMany(
    {},
    {
      $unset: {
        investigationId: '',
        'diagnostics.investigation': ''
      }
    }
  );
  console.log(`Reset ${incRes.modifiedCount} incidents.`);
  await mongoose.disconnect();
}

resetFixes().catch(console.error);

