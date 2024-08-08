/**
 * This code was the base to create 'mismatched_reports_pipedream.js that runs in pipedream'
 * This code run locally to test individual date reports
 * 
 * v.2.0
 * Makes a 2nd round search to detect repeated orders that are detected as mismatches
 */

const axios = require('axios');
const fs = require('fs');
require('dotenv').config();
const STRIPE_API_KEY = process.env.STRIPE_API_KEY;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;

const STRIPE_API_URL = `https://api.stripe.com/v1/payment_intents`
const HUBSPOT_API_URL = `https://api.hubapi.com/crm/v3/objects/deals/search`
const ZAPIER_WEBHOOK_URL = `https://hooks.zapier.com/hooks/catch/18928338/2bam4dq/` // Slack Channel Messenger https://zapier.com/editor/246218194/published

let stripeGrossAmount = 0;
let stripeRefundedAmount = 0;
let hsAmountTotal = 0;
const LIMIT = 100;

// We want yesterday's reports from Stripe and Hubspot
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const year = yesterday.getFullYear();
const month = String(yesterday.getMonth() + 1).padStart(2, '0'); // months are 0-based
const day = String(yesterday.getDate()).padStart(2, '0');
const date = `${year}-${month}-${day}`;

// const date = `2024-08-06`;

// Create an axios instance
const axiosInstance = axios.create();

// axiosInstance.interceptors.request.use(request => {
//   console.log('Starting Request', {
//     url: request.url,
//     method: request.method,
//     headers: request.headers,
//     params: request.params,
//     data: request.data
//   });

//   return request;

// }, error => {
//   console.error('Request Error', error);
//   return Promise.reject(error);
// });

// Add a response interceptor
// axiosInstance.interceptors.response.use(response => {
//   console.log('Response:', {
//     status: response.status,
//     data: response.data,
//     headers: response.headers,
//     config: response.config
//   });

//   return response;

// }, error => {
//   console.error('Response Error', error.response ? error.response.data : error.message);
//   return Promise.reject(error);
// });


async function getPaymentsStripe(date) {
  let payments = [];
  let hasMore = false;
  let startingAfter = null;

  let [start, end] = getRangeInTimestamp(date)
  const oneDay = 86400  // seconds in a day
  start = start - oneDay;

  // console.log('SR start timestamp : ' + start)
  // console.log('SR end timestamp : ' + end)

  try {
    do {
      const response = await axiosInstance.get(STRIPE_API_URL, {
        headers: {
          'Authorization': `Bearer ${STRIPE_API_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        params: {
          'created[gte]': start - 259200, // 259200 -> 3 days in seconds, we search 3 days old invoices in case they are paid in our time window
          'created[lte]': end,
          limit: LIMIT,
          starting_after: startingAfter, // pagination parameter
        }
      });

      payments.push(...response.data.data);

      // Check if there are more charges to fetch
      hasMore = response.data.has_more;
      if (hasMore) {
        // Update startingAfter with the last charge ID in the current batch
        startingAfter = response.data.data[response.data.data.length - 1].id;
      }

    } while (hasMore)

    return payments

  } catch (error) {
    console.error('Error fetching payments:', error.response ? error.response.data : error.message);
    return [];
  }
}


async function getPaymentsHubspot(date) {
  let deals = [];
  let nextPage = null;

  const [start, end] = getRangeInTimestamp(date)

  // console.log('HS start timestamp : ' + start * 1000)  // 1718002800 ==> Monday June 10, 2024 00:00:00 (am) in time zone America/Phoenix (MST)
  // console.log('HS end timestamp : ' + end * 1000)      // 1718089199 ==> Monday June 10, 2024 23:59:59 (pm) in time zone America/Phoenix (MST)

  try {
    do {
      const hubspotRequestBody = {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'dealstage',
                operator: 'EQ',
                value: 'closedwon'
              },
              {
                propertyName: 'closedate',
                operator: 'BETWEEN',
                highValue: end * 1000, // 1718089199000
                value: start * 1000  // 1718002800000 
              }
            ]
          }
        ],
        properties: ['dealname', 'dealstage', 'amount', 'closedate', 'deal_owner_email_address', 'wp_establishment_id', 'wp_user_id', 'stripe_user_id'], // Adjust properties as needed,
        limit: LIMIT,
        after: nextPage
      };

      const response = await axiosInstance.post(HUBSPOT_API_URL, hubspotRequestBody, {
        headers: {
          'Authorization': `Bearer ${HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      deals.push(...response.data.results);
      nextPage = response.data.paging?.next?.after;

    } while (nextPage)

  } catch (error) {
    console.error('Error fetching payments:', error.response ? error.response.data : error.message);
    return [];
  }

  return deals
}


async function createReport(date) {
  const stripeReportsAll = await getPaymentsStripe(date)
  const hsReportsAll = await getPaymentsHubspot(date)
  const [start, end] = getRangeInTimestamp(date)

  // Filter for successful payments, not refunds
  const stripeReports = stripeReportsAll.filter(
    payment => payment.status === 'succeeded'
      &&
      (
        (payment.charges.data[0].created >= start) && (payment.charges.data[0].created <= end) // some payments intents are charged in the future so we don't need them
        ||
        (payment.status_transitions?.finalized_at >= start) && (payment.status_transitions?.finalized_at <= end) // some payments intents were created in the past, but paid in our range
      )
  );

  stripeReports.forEach((payment) => {
    stripeGrossAmount += payment.amount
    stripeRefundedAmount += payment.charges.data[0].refunded ? payment.charges.data[0].refunds.data[0].amount : 0
    // console.log("SR amount: " + (payment.amount / 100) + " timestamp: " + payment.charges.data[0].created + " date: " + convertTimestamp(payment.charges.data[0].created)) // Todo : In which scenario we can have data[] more than 1 and how to handle?
  });


  // Filter reports without amount
  const hsReports = hsReportsAll.filter(payment =>
    // !isNaN(parseFloat(payment.properties.amount) * 100)
    !isNaN(parseFloat(payment.properties.amount))
  );

  hsReports.forEach((payment) => {
    const amount = parseFloat(payment.properties.amount) * 100;
    hsAmountTotal += amount;
  });



  console.log("Stripe reports: " + stripeReports.length)
  console.log("Hubspot reports: " + hsReports.length)

  console.log("Stripe Gross: $" + stripeGrossAmount / 100)
  console.log("Hubspot total: $" + hsAmountTotal / 100)

  // This is the difference amount of the 2 reports
  differenceAmount = (stripeGrossAmount - hsAmountTotal) / 100
  console.log("Difference: $" + differenceAmount)

  await findMismatched(stripeReports, hsReports);
}

// Converts date in format '2024-06-10' to America/Phoenix time zone
function getRangeInTimestamp(date) {
  let startDate = new Date(date);
  startDate.setUTCHours(0, 0, 0, 0);
  let endDate = new Date(date);
  endDate.setUTCHours(23, 59, 59);

  startDate = Math.round(startDate.getTime() / 1000)
  endDate = Math.round(endDate.getTime() / 1000)

  const sevenHoursInSeconds = 7 * 60 * 60; // 25200 seconds
  const start = startDate + sevenHoursInSeconds;
  const end = endDate + sevenHoursInSeconds;

  return [start, end]
}


// Function to compare if the second date is within 2 minutes of the first date
async function isWithinTwoMinutes(stripeTimestamp, hsDateString) {


  // console.log("stripeTimestamp: " + stripeTimestamp + " hsDateString: " + hsDateString)
  const hsDate = new Date(hsDateString);
  const hsTimestamp = Math.floor(hsDate.getTime() / 1000);

  // Calculate the difference in seconds
  const diffInSeconds = Math.abs(hsTimestamp - stripeTimestamp);

  // Check if the difference is within two minutes (2 * 60 * 1000 ms)
  return diffInSeconds <= 2 * 60 ? true : false;
}

async function findMismatched(stripeReports, hsReports) {
  let matched = [];
  let mismatched = [];
  let mismatchedTotal = 0;

  for (let i = stripeReports.length - 1; i >= 0; i--) {
    for (let k = hsReports.length - 1; k >= 0; k--) {

      // 1rst match is Date/Time (withing 2 minutes difference)
      if (
        await isWithinTwoMinutes(stripeReports[i].created, hsReports[k].properties.closedate)
        ||
        await isWithinTwoMinutes(stripeReports[i].charges.data[0].created, hsReports[k].properties.closedate)
      ) {

        // 2nd match is amount
        if ((stripeReports[i].amount / 100) == parseFloat(hsReports[k].properties.amount)) {

          matched.push(stripeReports[i])
          // since that transaction was matched, we should not check it again
          hsReports.splice(k, 1);
          break;

        } else {
          // Check for potential repeated orders that are masqueraded mismatches
          // Since time matches but not amount, we need to check for establishment or something else
          // and then try to find split amounts, add them and check if now total amount is equal 
          let indexHub = k;
          let sumHub = 0;
          const stripeAmount = stripeReports[i].amount / 100
          let keep = false;

          // Sum prices in hubspot list until the sum matches stipe price
          do {

            // match time
            // match establishments / userids
            // amounts should be stripeAmount % sumHub === 0

            // all hubAmounts in this inner loop should be identical AND leave no remainder
            // the sum of this inner loop should be equal to stripe amount

            if (sumHub < stripeAmount) {
              keep = true;
            }

            if (sumHub >= stripeAmount) {
              keep = false;
            }


            if (
              (
                await isWithinTwoMinutes(stripeReports[i].created, hsReports[k].properties.closedate)
                ||
                await isWithinTwoMinutes(stripeReports[i].charges.data[0].created, hsReports[k].properties.closedate)
              )
              &&

              stripeReports[i].metadata.establishmentId == hsReports[k].properties.wp_establishment_id
              ||
              stripeReports[i].metadata.clientId == hsReports[k].properties.wp_user_id

              &&
              Math.floor(stripeAmount % parseFloat(hsReports[indexHub].properties.amount)) === 0

            ) {
              sumHub += parseFloat(hsReports[indexHub].properties.amount)
              indexHub--;

              // If the sum does not match priceA, the lists do not match
              // if (parseFloat(sumHub.toFixed(1)) === stripeAmount) {
              if ((Math.round(sumHub * 100) / 100) === stripeAmount) {

                matched.push(stripeReports[i])

                // for (let j = k; j <= indexHub; j++) {
                for (let j = indexHub; j > k; j--) {
                  hsReports.splice(j, 1);
                }
                break;
              }
            } else {
              keep = false;
            }
          } while (keep && indexHub >= 0)

        }
      }
    }
  }

  // console.log("matched len: " + matched.length)

  mismatched = stripeReports.filter(item => !matched.includes(item));

  mismatched.forEach((payment) => {
    mismatchedTotal += payment.amount
  });


  const mismatchedReportsFile = `mismatched-${date}.json`
  const jsonString = JSON.stringify({ stripe: mismatched, hubspot: hsReports }, null, 2); // The parameters null, 2 are used to format the string with a 2-space indentation for readability.

  const text1 = `For ${date} there was a mismatch of $${mismatchedTotal / 100} between Stripe Gross volume $${stripeGrossAmount / 100} and HS Closed Deals $${hsAmountTotal / 100}. `
  const text2 = `There are ${mismatched.length} mismatched transactions listed on the ${mismatchedReportsFile} file. Total mismatched value is $${mismatchedTotal / 100} from which refunds is $${stripeRefundedAmount / 100}`
  const finalText = text1 + (mismatched.length > 0 ? text2 : "");

  const body = {
    "data": {
      "slackChannel": "wp-dev-internal",
      "message": `${finalText}`
    }
  }


  if (mismatched.length > 0) {
    fs.writeFile(mismatchedReportsFile, jsonString, (err) => {
      if (err) {
        console.error('Error writing file:', err);
      } else {
        console.log('File has been saved as', mismatchedReportsFile);
      }
    });
  } else {
    console.log("Send message in Slack without url")
    // await axiosInstance.post(ZAPIER_WEBHOOK_URL, body, {});
  }

  console.log(finalText)
}


createReport(date);