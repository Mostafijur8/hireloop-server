import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 5000;
const authBaseUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3000';
const allowedOrigin = process.env.CLIENT_URL || authBaseUrl;

// JSON request এবং credential-সহ cross-origin request চালু করি।
app.use(express.json());
app.use(cors({ origin: allowedOrigin, credentials: true }));

const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('You successfully connected to MongoDB!');
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectClient = await connectToMongoDB();
const database = connectClient.db('hireloopDB');
const users = database.collection('user');
const jobs = database.collection('jobs');

// Better Auth session দেখে শুধু recruiter-কে job publish করতে দিই।
async function getRecruiter(req, res, next) {
  try {
    const response = await fetch(`${authBaseUrl.replace(/\/$/, '')}/api/auth/get-session`, {
      headers: { cookie: req.headers.cookie || '' },
      cache: 'no-store',
    });
    const user = response.ok && (await response.json())?.user;

    if (!user) {
      return res.status(401).json({ error: 'Please sign in to publish a job.' });
    }
    if (user.role !== 'recruiter') {
      return res.status(403).json({ error: 'Only recruiters can publish jobs.' });
    }

    req.recruiter = user;
    next();
  } catch (error) {
    next(error);
  }
}

// Job-এর প্রয়োজনীয় field ও salary format যাচাই করি।
function isJob(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.title === 'string' &&
    value.title.trim() &&
    typeof value.location === 'string' &&
    value.location.trim() &&
    typeof value.type === 'string' &&
    value.type.trim() &&
    typeof value.description === 'string' &&
    value.description.trim() &&
    (value.companyName === undefined || typeof value.companyName === 'string') &&
    (value.deadline === undefined || typeof value.deadline === 'string') &&
    value.salaryRange &&
    typeof value.salaryRange === 'object' &&
    typeof value.salaryRange.min === 'string' &&
    typeof value.salaryRange.max === 'string' &&
    value.salaryRange.currency === 'BDT' &&
    value.salaryRange.period === 'monthly',
  );
}

app.get('/', (req, res) => {
  res.send('Hello World!');
});

// Return jobs, optionally filtered by job type and status.
app.get('/jobs', async (req, res) => {
  const query = {};

  if (req.query.jobtype) {
    query.type = req.query.jobtype;
  }
  if (req.query.status) {
    query.status = req.query.status;
  }

  res.send(await jobs.find(query).toArray());
});

// delete one job by id
app.delete('/jobs/:id', async (req, res) => {
  const jobId = req.params.id;
  if (!ObjectId.isValid(jobId)) {
    return res.status(400).json({ error: 'Please provide a valid job id.' });
  }

  const query = { _id: new ObjectId(jobId) };
  const result = await jobs.deleteOne(query);
  res.send(result);
});

// সব user-এর তথ্য ফেরত দিই।
app.get('/users', async (req, res) => {
  res.send(await users.find({}).toArray());
});

// যাচাইকৃত recruiter-এর job MongoDB-তে সংরক্ষণ করি।
app.post('/jobs', getRecruiter, async (req, res, next) => {
  if (!isJob(req.body)) {
    return res.status(400).json({ error: 'Please provide valid job details.' });
  }

  try {
    const job = {
      title: req.body.title.trim(),
      location: req.body.location.trim(),
      type: req.body.type.trim(),
      companyName: req.body.companyName?.trim() || req.recruiter.companyName || '',
      deadline: req.body.deadline || '',
      salaryRange: req.body.salaryRange,
      description: req.body.description.trim(),
      recruiterId: req.recruiter.id,
      status: 'active',
      createdAt: new Date(),
    };
    const result = await jobs.insertOne(job);
    res.status(201).json({ id: result.insertedId.toString(), ...job });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  // Server-side error log করে সাধারণ error response পাঠাই।
  console.error('API request failed:', error);
  res.status(500).json({ error: 'The server could not complete the request.' });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
