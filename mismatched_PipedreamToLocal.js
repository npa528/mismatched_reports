/**
 * This code was is an effort to make Pipedrem code as close as possible to code run locally
 * for easier and quicker testing with minimum time to port code back to Pipedream-action compatible
 * 
 * v.0.1
*/

import axios from 'axios';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const STRIPE_CHARGES_API = `https://api.stripe.com/v1/charges`
const HUBSPOT_API_URL = `https://api.hubapi.com/crm/v3/objects/deals/search`
const ZAPIER_WEBHOOK_URL = `https://hooks.zapier.com/hooks/catch/18928338/2bam4dq/` // Slack Channel Messenger https://zapier.com/editor/246218194/published
const FRESHBOOKS_AUTH_URL = `https://api.freshbooks.com/auth/oauth/token`
const FB_ACCOUNT_ID = `XVR1K`
const FRESHBOOKS_PAYMENTS_URL = `https://api.freshbooks.com/accounting/account/${FB_ACCOUNT_ID}/payments/payments`

let stripeGrossAmount = 0;
let stripeRefundedAmount = 0;
let hsAmountTotal = 0;
let freshbooksTotal = 0
let stripeFbTotal = 0
const LIMIT = 100;


function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-based
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// We want yesterday's reports from Stripe and Hubspot
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const date = formatDate(yesterday)
const dateToday = formatDate(new Date());

// const date = `2024-11-21`;
// const dateToday = `2024-11-22`;


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

// // Add a response interceptor
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


async function getFreshbooksToken(FB_GRANT_TYPE, FB_CLIENT_ID, FB_REFRESH_TOKEN, FB_CLIENT_SECRET) {
  console.log("current token: " + FB_REFRESH_TOKEN)

  // const refreshToken = '2ec6756647297d64f20b6868e0a7165fc423ee6f7e7ce4eae1256a3e24271cca'

  try {
    const body = {
      grant_type: FB_GRANT_TYPE,
      client_id: FB_CLIENT_ID,
      refresh_token: FB_REFRESH_TOKEN,
      client_secret: FB_CLIENT_SECRET
    }

    const response = await axiosInstance.post(FRESHBOOKS_AUTH_URL, body, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const newRefreshToken = response.data.refresh_token
    const accessToken = response.data.access_token
    console.log("newRefreshToken: " + newRefreshToken)
    await saveToken(newRefreshToken)

    return accessToken

  } catch (error) {
    if (error.response) {
      console.error('Error status:', error.response.status); // Status code
      console.error('Error data:', error.response.data); // The response body with more error info
    } else {
      console.error('Error message:', error.message); // Generic error message
    }
  }
}


async function getPaymentsFreshbooks(date, FB_GRANT_TYPE, FB_CLIENT_ID, FB_CLIENT_SECRET, FB_REFRESH_TOKEN) {
  console.log("entered getPaymentsFreshbooks: " + FB_REFRESH_TOKEN)
  let payments = [];

  const accessToken = await getFreshbooksToken(FB_GRANT_TYPE, FB_CLIENT_ID, FB_REFRESH_TOKEN, FB_CLIENT_SECRET);

  try {
    const response = await axiosInstance.get(FRESHBOOKS_PAYMENTS_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      params: {
        'search[date_min]': date,
        'search[date_max]': dateToday,
        'per_page': 100
      }
    });

    console.log("FB payments len: " + payments.length)

    if (response.data && response.data.response && response.data.response.result) {
      payments = response.data.response.result.payments;
    }

    return payments

  } catch (error) {
    if (error.response.data.response.errors[0].errno === 1003) { // The server could not verify that you are authorized to access the URL requested
      console.log("error 1003")

    } else {
      console.error('Error fetching Freshbooks payments. Errno: ' + error.response.data.response.errors[0].errno + " Message: " + error.response.data.response.errors[0].message)
    }
  }
}


// Enpoint can be: Charges or Refunds
async function getPaymentsStripe(date, STRIPE_API_KEY) {
  let payments = [];
  let hasMore = false;
  let startingAfter = null;

  let [start, end] = getRangeInTimestamp(date)
  const oneDay = 86400  // seconds in a day
  start = start - oneDay;

  // console.log('Start : ' + start)
  // console.log('End : ' + end)

  try {
    do {
      const response = await axiosInstance.get(STRIPE_CHARGES_API, {
        headers: {
          'Authorization': `Bearer ${STRIPE_API_KEY} `,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        params: {
          'created[gte]': start,
          'created[lte]': end,
          limit: LIMIT,
          starting_after: startingAfter, // pagination parameter
        }
      });

      // console.log("payments len: " + payments.length)

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
    console.error('Error fetching Stripe payments:', error.response ? error.response.data : error.message);
    return [];
  }
}


async function getPaymentsHubspot(date, HUBSPOT_API_KEY) {
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
          'Authorization': `Bearer ${HUBSPOT_API_KEY} `,
          'Content-Type': 'application/json'
        }
      });

      deals.push(...response.data.results);
      nextPage = response.data.paging?.next?.after;

    } while (nextPage)

  } catch (error) {
    console.error('Error fetching Hubspot payments:', error.response ? error.response.data : error.message);
    return [];
  }

  return deals
}


async function createReport(date, stripeApiKey, hubspotApiKey, fbGrantType, fbClienId, fbClientSecret, fbRefreshToken) {

  const stripeReportsAll = await getPaymentsStripe(date, stripeApiKey)
  const hsReportsAll = await getPaymentsHubspot(date, hubspotApiKey)
  const fbReports = await getPaymentsFreshbooks(date, fbGrantType, fbClienId, fbClientSecret, fbRefreshToken)

  const [start, end] = getRangeInTimestamp(date)

  // Filter for successful payments, not refunds
  const stripeReports = stripeReportsAll.filter(
    payment => payment.status === 'succeeded'
      &&
      ((payment.created >= start) && (payment.created <= end))
  );

  stripeReports.forEach((payment) => {
    stripeGrossAmount += (payment.amount_refunded === 0) ? payment.amount_captured : 0
    stripeRefundedAmount += (payment.amount_refunded !== 0) ? payment.amount_refunded : 0
  });


  for (let i = 0; i < fbReports.length; i++) {
    const payment = fbReports[i];
    if (payment.updated.includes(date)) {
      const amount = parseFloat(payment.amount.amount);
      freshbooksTotal += amount;
    } else {
      fbReports.splice(i, 1);
      i--; // Adjust the index to account for the removed element
    }
  }

  // Filter reports without amount
  const hsReports = hsReportsAll.filter(payment =>
    // !isNaN(parseFloat(payment.properties.amount) * 100)
    !isNaN(parseFloat(payment.properties.amount))
  );

  hsReports.forEach((payment) => {
    const amount = parseFloat(payment.properties.amount) * 100;
    hsAmountTotal += amount;

    // console.log("Amount: " + payment.properties.amount)
  });

  console.log("Stripe reports: " + stripeReports.length)
  console.log("Hubspot reports: " + hsReports.length)
  console.log("Freshbooks reports: " + fbReports.length)

  console.log("Stripe total: $" + stripeGrossAmount / 100)
  stripeFbTotal = stripeGrossAmount / 100 + freshbooksTotal

  console.log("Stripe + FB total: $" + stripeFbTotal)
  console.log("FB Only total: $" + freshbooksTotal)
  console.log("Hubspot total: $" + hsAmountTotal / 100)

  // This is the difference amount of the 2 reports
  const differenceAmount = (stripeFbTotal * 100) - (hsAmountTotal * 100) / 100
  console.log("Difference: $" + differenceAmount / 100)

  // const stripeRefunds = await getPaymentsStripe(STRIPE_REFUNDS_API, date)

  // stripeRefunds.forEach((refund) => {
  //   stripeRefundedAmount += refund.amount
  //   console.log("Stripe refunds: $" + stripeRefundedAmount / 100)
  // });

  await findMismatched(stripeReports, hsReports, fbReports);
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



// At the moment of writing, Freshbooks API returns 2024-11-13 16:55:57 while same deal in HS has closed date 2024-11-13T21:55:58.892Z (UTC)
// So Freshbook seems to be using a timezone UTC -5
// TODO We should check if this will change with daylight saving time
async function isWithinTwoMinutesForFreshbooks(freshbooksTimeString, hsDateString) {

  const fb_localDate = new Date(`${freshbooksTimeString} UTC-0500`);
  const fb_timestamp = Math.floor(fb_localDate.getTime() / 1000) // fb_localDate.getTime();

  // console.log("stripeTimestamp: " + stripeTimestamp + " hsDateString: " + hsDateString)
  const hsDate = new Date(hsDateString);
  const hsTimestamp = Math.floor(hsDate.getTime() / 1000);

  // Calculate the difference in seconds
  const diffInSeconds = Math.abs(hsTimestamp - fb_timestamp);

  // console.log("hsTimestamp: " + hsTimestamp + " fb_timestamp: " + fb_timestamp)
  // console.log("fb diffInSeconds: " + diffInSeconds)

  // Check if the difference is within two minutes (2 * 60 * 1000 ms)
  return diffInSeconds <= 2 * 60 ? true : false;
}


async function findMismatched(stripeReports, hsReports, fbReports) {
  let matched = [];
  let stripeMismatched = []; //  mismatched
  let mismatchedTotal = 0;

  for (let i = stripeReports.length - 1; i >= 0; i--) {
    for (let k = hsReports.length - 1; k >= 0; k--) {

      // 1rst match is amount
      if ((stripeReports[i].amount / 100) == parseFloat(hsReports[k].properties.amount)) {

        // 2nd match is establishment
        if (
          (stripeReports[i].metadata.establishmentId === hsReports[k].properties.wp_establishment_id)
          ||
          (stripeReports[i].metadata.clientId === hsReports[k].properties.wp_user_id)
          ||
          (stripeReports[i].customer === hsReports[k].properties.stripe_user_id)
          ||
          (stripeReports[i].billing_details.email === hsReports[k].properties.deal_owner_email_address)
          ||
          (stripeReports[i].description?.includes(hsReports[k].properties.deal_owner_email_address))
        ) {
          matched.push(stripeReports[i])
          // since that transaction was matched, we should not check it again
          hsReports.splice(k, 1);
          break;
        }


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


          if (await isWithinTwoMinutes(stripeReports[i].created, hsReports[k].properties.closedate)
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
            if ((Math.round(sumHub * 100) / 100) === stripeAmount) {

              matched.push(stripeReports[i])

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

  stripeMismatched = stripeReports.filter(item => !matched.includes(item));

  console.log("stripeMismatched len CP1: " + stripeMismatched.length)

  // We will make a final check (Level 2 check) based on time (isWithinTwoMinutes) only for the previously mismatched reports
  // to catch some transactions that match in amount and time but differ in other details. These transactions are usually lenders paying on behalf of some other client
  // and Establishmet or others IDs do not match.
  let matchedLevel2 = [];

  for (let i = stripeMismatched.length - 1; i >= 0; i--) {
    for (let k = hsReports.length - 1; k >= 0; k--) {

      // 1rst match is Date/Time (withing 2 minutes difference)
      if (await isWithinTwoMinutes(stripeMismatched[i].created, hsReports[k].properties.closedate)) {
        matchedLevel2.push(stripeMismatched[i])
        hsReports.splice(k, 1);
        break;
      }
    }
  }

  let matchedLevel3 = [];
  // Here we will do a final check (Level 3). We want to compare payments from Freshbooks, with the remaining of Hubspot deals which have not been matched yet
  for (let i = fbReports.length - 1; i >= 0; i--) {
    for (let k = hsReports.length - 1; k >= 0; k--) {

      // console.log("FB amount: " + parseFloat(fbReports[i].amount.amount) + " HS amount: " + parseFloat(hsReports[k].properties.amount))

      // 1rst match amount
      if (parseFloat(fbReports[i].amount.amount) == parseFloat(hsReports[k].properties.amount)) {

        // 2nd match is Date/Time (withing 2 minutes difference)
        if (await isWithinTwoMinutesForFreshbooks(fbReports[i].updated, hsReports[k].properties.closedate)) {
          matchedLevel3.push(fbReports[i])
          fbReports.splice(i, 1);
          hsReports.splice(k, 1);
          break;
        }
      }
    }
  }

  console.log("Matched in level 2: " + matchedLevel2.length)
  console.log("Matched in level 3: " + matchedLevel3.length)

  stripeMismatched = stripeMismatched.filter(item => !matchedLevel2.includes(item));

  // Add mismatch total for Stripe payments not matched with HS 
  stripeMismatched.forEach((payment) => {
    mismatchedTotal += (payment.amount_refunded === 0) ? payment.amount_captured : 0
  });

  // Add mismatch total for Freshbooks payments not matched with HS
  fbReports.forEach((payment) => {
    mismatchedTotal += parseFloat(payment.amount.amount)
  });

  const mismatchedReportsFile = `mismatched-${date}.json`
  const jsonString = JSON.stringify({ freshbooks: fbReports, stripe: stripeMismatched, hubspot: hsReports }, null, 2); // The parameters null, 2 are used to format the string with a 2-space indentation for readability.

  const text1 = `For ${date} there was a mismatch of $${mismatchedTotal / 100} between Stripe Gross (includes Freshbooks payments) volume $${stripeFbTotal}, HS Closed Deals $${hsAmountTotal / 100} `
  const text2 = `There are ${stripeMismatched.length} mismatched transactions listed on the ${mismatchedReportsFile} file. Refunded amount is $${stripeRefundedAmount / 100} `
  const finalText = text1 + (stripeMismatched.length > 0 ? text2 : "");

  // Used for local code - not in pipedream
  fs.writeFile(mismatchedReportsFile, jsonString, (err) => {
    if (err) {
      console.error('Error writing file:', err);
    } else {
      console.log('File has been saved as', mismatchedReportsFile);
    }
  });

  console.log(finalText)
}


// Used for local code as is - in pipedream with different implementation
async function saveToken(content) {
  console.log("save new token: " + content)
  fs.writeFile('mismatched_reports/refreshToken.txt', content, (err) => {
    if (err) throw err;
    console.log('Token updated');
  });
}


async function readToken() {
  return fs.readFileSync('mismatched_reports/refreshToken.txt', 'utf8');
}

async function defineComponent(date) {
  const STRIPE_API_KEY = process.env.STRIPE_API_KEY // STANDARD KEY
  const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY // HS-Stripe mismatched reports app
  const FB_GRANT_TYPE = process.env.FB_GRANT_TYPE
  const FB_CLIENT_ID = process.env.FB_CLIENT_ID
  const FB_CLIENT_SECRET = process.env.FB_CLIENT_SECRET

  // Read contents of file 'refreshToken.txt'
  const FB_REFRESH_TOKEN = await readToken()
  console.log("FB_REFRESH_TOKEN: " + FB_REFRESH_TOKEN)

  await createReport(date, STRIPE_API_KEY, HUBSPOT_API_KEY, FB_GRANT_TYPE, FB_CLIENT_ID, FB_CLIENT_SECRET, FB_REFRESH_TOKEN);

}

defineComponent(date);