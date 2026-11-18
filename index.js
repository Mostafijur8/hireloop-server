import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import stripe from 'stripe';

const stripeInstance = new stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;
const authBaseUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3000';
const allowedOrigin = process.env.CLIENT_URL || authBaseUrl;
// Payment লাগলে seeker-কে client-এর payment page-এ পাঠাই।
const paymentPageUrl = process.env.PAYMENT_PAGE_URL || `${allowedOrigin.replace(/\/$/, '')}/payment`;

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
const applications = database.collection('applications');
const payments = database.collection('payments');

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

// Better Auth session দেখে signed-in user-কে request-এ যুক্ত করি।
async function getSignedInUser(req, res, next) {
  try {
    const response = await fetch(`${authBaseUrl.replace(/\/$/, '')}/api/auth/get-session`, {
      headers: { cookie: req.headers.cookie || '' },
      cache: 'no-store',
    });
    const user = response.ok && (await response.json())?.user;

    if (!user) {
      return res.status(401).json({ error: 'Please sign in first.' });
    }

    req.user = user;
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
    (value.isRemote === undefined || typeof value.isRemote === 'boolean') &&
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

// Return jobs, optionally filtered by supported query parameters.
app.get('/jobs', async (req, res) => {
  const query = {};

  const stringFilters = [
    'title',
    'companyName',
    'category',
    'location',
    'type',
    'status',
    'deadline',
    'description',
    'requirements',
    'responsibilities',
  ];
  for (const field of stringFilters) {
    const value = req.query[field] ?? (field === 'type' ? req.query.jobtype : undefined);
    if (typeof value === 'string' && value.trim()) {
      query[field] = { $regex: value.trim(), $options: 'i' };
    }
  }

  if (req.query.isRemote !== undefined) {
    if (!['true', 'false'].includes(req.query.isRemote)) {
      return res.status(400).json({ error: 'isRemote must be true or false.' });
    }
    query.isRemote = req.query.isRemote === 'true';
  }

  if (req.query.salaryPeriod) {
    query['salaryRange.period'] = { $regex: req.query.salaryPeriod, $options: 'i' };
  }
  if (req.query.currency) {
    query['salaryRange.currency'] = { $regex: req.query.currency, $options: 'i' };
  }

  res.send(await jobs.find(query).toArray());
});

// একটি job-এর বিস্তারিত তথ্য id দিয়ে ফেরত দিই।
app.get('/jobs/:id', async (req, res, next) => {
  const jobId = req.params.id;
  if (!ObjectId.isValid(jobId)) {
    return res.status(400).json({ error: 'Please provide a valid job id.' });
  }

  try {
    const job = await jobs.findOne({ _id: new ObjectId(jobId) });
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }
    res.json(job);
  } catch (error) {
    next(error);
  }
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

// Signed-in seeker's applications এবং সংশ্লিষ্ট job details ফেরত দিই।
app.get('/applications', getSignedInUser, async (req, res, next) => {
  try {
    const result = await applications
      .aggregate([
        { $match: { seekerId: req.user.id } },
        {
          $addFields: {
            jobObjectId: {
              $convert: { input: '$jobId', to: 'objectId', onError: null, onNull: null },
            },
          },
        },
        {
          $lookup: {
            from: 'jobs',
            localField: 'jobObjectId',
            foreignField: '_id',
            as: 'job',
          },
        },
        { $unwind: { path: '$job', preserveNullAndEmptyArrays: true } },
        { $sort: { appliedAt: -1, _id: -1 } },
        { $project: { jobObjectId: 0 } },
      ])
      .toArray();

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Signed-in seeker-এর application যাচাই করে MongoDB-তে সংরক্ষণ করি।
app.post('/applications', getSignedInUser, async (req, res, next) => {
  try {
    const { jobId } = req.body;

    if (typeof jobId !== 'string' || !ObjectId.isValid(jobId)) {
      return res.status(400).json({ error: 'Please provide a valid jobId.' });
    }

    const jobObjectId = new ObjectId(jobId);
    const job = await jobs.findOne({ _id: jobObjectId });
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    const existingApplication = await applications.findOne({
      seekerId: req.user.id,
      jobId: jobObjectId,
    });
    if (existingApplication) {
      return res.status(409).json({ error: 'You have already applied to this job.' });
    }

    // প্রথম ৫টি application ফ্রি; এরপর নতুন application-এর আগে payment page-এ পাঠানোর সংকেত দিই।
    const applicationCount = await applications.countDocuments({ seekerId: req.user.id });
    const hasPaidAccess = await payments.findOne({ userId: req.user.id });
    if (applicationCount >= 5 && !hasPaidAccess) {
      return res.status(402).json({
        error:
          'You have reached the free application limit. Payment is required to apply to more jobs.',
        paymentRequired: true,
        redirectTo: paymentPageUrl,
      });
    }

    const application = {
      seekerId: req.user.id,
      jobId: jobObjectId,
      status: 'Applied',
      appliedAt: new Date(),
    };

    const result = await applications.insertOne(application);
    res.status(201).json({
      message: 'Application submitted.',
      application: { _id: result.insertedId, ...application },
    });
  } catch (error) {
    next(error);
  }
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
      isRemote: req.body.isRemote ?? false,
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

// Signed-in user-এর Stripe Checkout payment যাচাই করে একবারই payment record রাখি।
app.post('/payments/checkout-verify', getSignedInUser, async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ success: false, error: 'Please provide a valid checkout session id.' });
    }

    const session = await stripeInstance.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.userId !== req.user.id || session.mode !== 'payment') {
      return res.status(403).json({ success: false, error: 'This checkout session does not belong to you.' });
    }
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ success: false, message: 'Payment is not completed.' });
    }

    await payments.updateOne(
      { checkoutSessionId: session.id },
      {
        $setOnInsert: {
          userId: req.user.id,
          checkoutSessionId: session.id,
          email: session.customer_details?.email ?? req.user.email,
          customerName: session.customer_details?.name ?? '',
          paidAt: new Date(),
          amountTotal: session.amount_total,
          currency: session.currency,
          transactionId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        },
      },
      { upsert: true },
    );

    return res.json({ success: true, message: 'Payment successful.' });
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
